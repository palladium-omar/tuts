import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Database, emitEvent, logDiagnostic, parseBody, Public } from "@palladium/service-kit";
import { defaultPermissions, hasPermission, type RequestContext } from "@palladium/contracts";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { IdentityService } from "./identity.service.js";
import { membershipPolicy, type MembershipPolicy, type MembershipPolicyRow } from "./membership-policy.js";
import {
  businessIdSchema,
  clientDiagnosticsSchema,
  businessSchema,
  internalContextSchema,
  settingsSchema,
  mergeSettings,
  visibleBusinessSettings,
} from "./schemas.js";

type BusinessRow = MembershipPolicyRow & {
  business_id: string;
  name: string;
  entitlements: string[];
  settings: Record<string, unknown>;
  created_at: Date;
  role: RequestContext["role"];
  business_profile_revision: string;
};
const businessItem = (row: BusinessRow, policy: MembershipPolicy) => ({
  id: row.business_id,
  name: row.name,
  role: row.role,
  entitlements: row.entitlements,
  settings: visibleBusinessSettings(row.settings,
    policy.accessScope === "business" && hasPermission({role: row.role, ...policy}, "platform.read")),
  createdAt: row.created_at,
  ...policy,
});

async function emitBusinessProfile(tx: PoolClient, row: BusinessRow) {
  await emitEvent(tx, {
    type: "platform.business-profile-updated.v1",
    producer: "platform",
    businessId: row.business_id,
    data: {
      businessId: row.business_id,
      name: row.name,
      profile: row.settings.profile ?? {},
      branding: row.settings.branding ?? {},
      revision: Number(row.business_profile_revision),
    },
  });
}

@Public()
@ApiTags("businesses")
@Controller("v1")
export class BusinessesController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  @Get("session")
  @ApiOperation({
    summary: "Get the signed-in user without exposing the session token",
  })
  async session(@Req() req: Request) {
    const session = await this.identity.requireSession(req);
    return {
      item: { user: session.user, expiresAt: session.session.expiresAt },
    };
  }

  @Post("client-diagnostics")
  @ApiOperation({ summary: "Record bounded, categorical browser error diagnostics" })
  async clientDiagnostics(@Req() req: Request, @Body() body: unknown) {
    await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const contentType = req.headers['content-type'];
    const length = req.headers['content-length'];
    const rawBody = (req as Request & {rawBody?: Buffer}).rawBody;
    if (typeof contentType !== 'string' || !/^application\/json(?:;|$)/i.test(contentType) ||
        (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 2048)) || (Buffer.isBuffer(rawBody) && rawBody.length > 2048))
      throw new BadRequestException('Diagnostics require a bounded JSON body');
    const input = parseBody(clientDiagnosticsSchema, body);
    const categories = new Map<string, { event: typeof input.events[number]; count: number }>();
    for (const event of input.events) {
      const key = `${event.kind}:${event.source}:${event.view}`, previous = categories.get(key);
      categories.set(key, { event, count: (previous?.count ?? 0) + 1 });
    }
    for (const { event, count } of categories.values())
      logDiagnostic('warn', 'browser_error', { browserKind: event.kind, source: event.source, view: event.view, count });
    return { item: { accepted: input.events.length } };
  }

  @Get("businesses")
  @ApiOperation({
    summary: "List up to 100 businesses the signed-in user belongs to",
  })
  async list(@Req() req: Request) {
    const session = await this.identity.requireSession(req);
    return this.businessesForUser(session.user.id);
  }

  @Get("bootstrap")
  @ApiOperation({ summary: "Get session and authorized businesses in one request" })
  async bootstrap(@Req() req: Request) {
    const session = await this.identity.requireSession(req);
    return { item: { user: session.user, expiresAt: session.session.expiresAt },
      ...await this.businessesForUser(session.user.id) };
  }

  private async businessesForUser(userId: string) {
    const directory = await this.db.pool.query<{ business_id: string }>(
      "SELECT business_id FROM identity_business_directory WHERE user_id = $1 ORDER BY business_id LIMIT 100",
      [userId],
    );
    // Each worker still verifies current membership and policy under tenant RLS.
    // A small fixed bound avoids exhausting the invocation's PostgreSQL pool.
    const items: Array<ReturnType<typeof businessItem> | null> = new Array(directory.rows.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, directory.rows.length) }, async () => {
      while (cursor < directory.rows.length) {
        const index = cursor++, entry = directory.rows[index]!;
        items[index] = await this.db.withTenant(entry.business_id, async (tx) => {
          const result = await tx.query<BusinessRow>(
            "SELECT b.*, m.role,m.permissions_override,m.access_scope FROM businesses b JOIN memberships m USING (business_id) WHERE m.user_id = $1",
            [userId],
          );
          const row = result.rows[0];
          return row ? businessItem(row, await membershipPolicy(tx, userId, row)) : null;
        });
      }
    }));
    return { items: items.filter((item): item is ReturnType<typeof businessItem> => item !== null) };
  }

  @Post("businesses")
  @ApiOperation({
    summary:
      "Create a business and owner membership with deployment-configured initial features",
  })
  async create(@Req() req: Request, @Body() body: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const input = parseBody(businessSchema, body);
    const id = randomUUID();
    const settings = mergeSettings(
      {
        version: 1,
        timezone: input.timezone,
        language: "en",
        profile: {},
        branding: {
          displayName: input.name,
          primaryColor: "#2563eb",
          secondaryColor: "#0f766e",
          backgroundColor: "#ffffff",
          textColor: "#172033",
        },
      },
      { profile: input.profile, branding: input.branding },
    );
    return this.db.withTenant(id, async (tx) => {
      const result = await tx.query<BusinessRow>(
        "INSERT INTO businesses (business_id, name, entitlements, settings) VALUES ($1,$2,$3,$4) RETURNING *",
        [
          id,
          input.name,
          [...this.identity.initialBusinessEntitlements],
          settings,
        ],
      );
      await tx.query(
        "INSERT INTO memberships (business_id, user_id, role) VALUES ($1,$2,$3)",
        [id, session.user.id, "owner"],
      );
      await tx.query(
        "INSERT INTO identity_business_directory (user_id, business_id) VALUES ($1,$2)",
        [session.user.id, id],
      );
      await emitEvent(tx, {
        type: "platform.business-created.v1",
        producer: "platform",
        businessId: id,
        data: { businessId: id },
      });
      const owner = { ...result.rows[0]!, role: "owner" as const,
        permissions_override: null, access_scope: "business" as const };
      await emitBusinessProfile(tx, owner);
      return { item: businessItem(owner, {
        permissions: defaultPermissions("owner"), accessScope: "business",
        studentIds: [], policyVersion: 1,
      }) };
    });
  }

  @Patch("businesses/:businessId/settings")
  @ApiOperation({
    summary:
      "Update profile, branding, timezone and language as owner/admin; entitlements cannot be changed",
  })
  async settings(
    @Req() req: Request,
    @Param("businessId") businessId: string,
    @Body() body: unknown,
  ) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const id = parseBody(businessIdSchema, businessId);
    const input = parseBody(settingsSchema, body);
    return this.db.withTenant(id, async (tx) => {
      const result = await tx.query<BusinessRow>(
        "SELECT b.*,m.role,m.permissions_override,m.access_scope FROM businesses b JOIN memberships m USING (business_id) WHERE m.user_id = $1 FOR UPDATE OF b",
        [session.user.id],
      );
      const current = result.rows[0];
      if (!current)
        throw new ForbiddenException("Business membership is required");
      if (!["owner", "admin"].includes(current.role))
        throw new ForbiddenException("Owner or admin role is required");
      const policy = await membershipPolicy(tx, session.user.id, current);
      if (policy.accessScope !== "business" || !hasPermission({ role: current.role, ...policy }, "platform.write"))
        throw new ForbiddenException("Business settings permission is required");
      const settings = mergeSettings(current.settings, input);
      const updated = await tx.query<BusinessRow>(
        "UPDATE businesses SET settings=$1, updated_at=now(), business_profile_revision=business_profile_revision+1 WHERE business_id=$2 RETURNING *",
        [settings, id],
      );
      await emitEvent(tx, {
        type: "platform.settings-updated.v1",
        producer: "platform",
        businessId: id,
        data: { version: 1 },
      });
      await emitBusinessProfile(tx, {
        ...updated.rows[0]!,
        role: current.role,
        permissions_override: current.permissions_override,
        access_scope: current.access_scope,
      });
      return {
        item: businessItem({ ...updated.rows[0]!, role: current.role }, policy),
      };
    });
  }
}

@Public()
@ApiTags("internal")
@Controller("internal")
export class ContextController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  @Post("context")
  @ApiOperation({
    summary: "Gateway-only session and business membership verification",
  })
  async context(@Req() req: Request, @Body() body: unknown) {
    this.identity.assertInternalSecret(req);
    const session = await this.identity.requireSession(req);
    const { businessId } = parseBody(internalContextSchema, body);
    return { item: await this.identity.requireBusinessContext(session, businessId) };
  }
}
