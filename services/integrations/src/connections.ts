import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  CurrentContext,
  Database,
  emitEvent,
  EventBus,
  parseBody,
  Public,
  Roles,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  connectionSchema,
  configSchema,
  type Config,
  type Provider,
} from "./schemas.js";
import { ConnectorError, decrypt, encrypt, hashSecret } from "./security.js";
import {
  mappedContacts,
  pull,
  type SyncData,
  validateAccount,
} from "./providers.js";
const uuid = z.string().uuid();
const patchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    credentials: z
      .object({
        token: z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[^\r\n]+$/),
      })
      .strict()
      .optional(),
    config: configSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide connection fields");
type Row = {
  id: string;
  business_id: string;
  created_by: string;
  provider: Provider;
  display_name: string;
  credentials_encrypted: string | null;
  webhook_secret_hash: string | null;
  config: Config;
  account: Record<string, unknown>;
  status: string;
  last_sync_at: Date | null;
  last_attempt_at: Date | null;
  last_error: string | null;
  next_sync_at: Date | null;
  sync_counts: Record<string, unknown>;
  last_import_result: Record<string, unknown> | null;
  dispatch_entitlements: string[];
  created_at: Date;
  updated_at: Date;
};
function view(row: Row) {
  return {
    id: row.id,
    businessId: row.business_id,
    ownerUserId: row.created_by,
    provider: row.provider,
    displayName: row.display_name,
    config: row.config,
    account: row.account,
    status: row.status,
    lastSyncAt: row.last_sync_at?.toISOString() ?? null,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastError: row.last_error,
    nextSyncAt: row.next_sync_at?.toISOString() ?? null,
    syncCounts: row.sync_counts,
    lastImportResult: row.last_import_result,
    dispatchEntitlements: row.dispatch_entitlements,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.provider === "form_webhook"
      ? { webhookPath: `/api/integrations/hooks/${row.business_id}/${row.id}` }
      : {}),
  };
}
function message(error: unknown) {
  return error instanceof ConnectorError
    ? error.safeMessage
    : "Synchronization could not be completed";
}
@Injectable()
export class ConnectionsService {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopping = false;
  private businessCursor = "";
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}
  onModuleInit() {
    const importResult = z.object({
      connectionId: uuid,
      created: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
      issues: z
        .array(
          z.object({
            externalId: z.string().max(512),
            reason: z.string().max(500),
          }),
        )
        .max(200),
    });
    this.events.subscribe("clients.source-synced.v1", async (event, tx) => {
      if (event.producer !== "clients")
        throw new Error("Invalid import report producer");
      const result = importResult.parse(event.data);
      await tx.query(
        `UPDATE integration_connections SET last_import_result=$3 WHERE business_id=$1 AND id=$2 AND (last_import_result IS NULL OR (last_import_result->>'receivedAt')::timestamptz <= $4::timestamptz)`,
        [
          event.businessId,
          result.connectionId,
          JSON.stringify({ ...result, receivedAt: event.occurredAt }),
          event.occurredAt,
        ],
      );
    });
    this.timer = setInterval(() => void this.poll(), 30000);
    this.timer.unref();
    void this.poll();
  }
  onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }
  async list(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) => ({
      items: (
        await tx.query<Row>(
          "SELECT * FROM integration_connections WHERE business_id=$1 ORDER BY created_at DESC LIMIT 200",
          [ctx.businessId],
        )
      ).rows.map(view),
    }));
  }
  async one(ctx: RequestContext, id: string) {
    parseBody(uuid, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<Row>(
          "SELECT * FROM integration_connections WHERE business_id=$1 AND id=$2",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Connection not found");
      return { item: view(row) };
    });
  }
  async create(ctx: RequestContext, body: unknown) {
    const input = parseBody(connectionSchema, body);
    if (
      ["json_api", "form_webhook"].includes(input.provider) &&
      !ctx.entitlements.includes("clients")
    )
      throw new ForbiddenException("Contact sources require the CRM feature");
    const secret =
      input.provider === "form_webhook"
        ? randomBytes(32).toString("base64url")
        : undefined;
    const encrypted =
      input.provider === "form_webhook"
        ? null
        : encrypt(input.credentials, ctx.businessId);
    let account: Record<string, unknown>;
    try {
      account = await validateAccount(
        input.provider,
        input.credentials.token,
        input.config,
      );
    } catch (error) {
      throw new BadGatewayException(message(error));
    }
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `integration-create:${ctx.businessId}`,
      ]);
      const total = await tx.query<{ count: string }>(
        "SELECT count(*) FROM integration_connections WHERE business_id=$1 AND status <> 'disconnected'",
        [ctx.businessId],
      );
      if (Number(total.rows[0]?.count) >= 50)
        throw new ConflictException("Connection limit reached");
      await tx.query(
        "INSERT INTO integration_tenant_directory(business_id) VALUES($1) ON CONFLICT DO NOTHING",
        [ctx.businessId],
      );
      const row = (
        await tx.query<Row>(
          `INSERT INTO integration_connections(id,business_id,created_by,provider,display_name,credentials_encrypted,webhook_secret_hash,config,account,dispatch_entitlements,status,next_sync_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'connected',CASE WHEN $4='form_webhook' THEN NULL ELSE now() END) RETURNING *`,
          [
            randomUUID(),
            ctx.businessId,
            ctx.sub,
            input.provider,
            input.displayName,
            encrypted,
            secret ? hashSecret(secret) : null,
            JSON.stringify(input.config),
            JSON.stringify(account),
            ctx.entitlements,
          ],
        )
      ).rows[0]!;
      return { item: view(row), ...(secret ? { webhookSecret: secret } : {}) };
    });
  }
  async update(ctx: RequestContext, id: string, body: unknown) {
    parseBody(uuid, id);
    const patch = parseBody(patchSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<Row>(
          "SELECT * FROM integration_connections WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Connection not found");
      if (row.status === "disconnected")
        throw new ConflictException("Create a new connection to reconnect");
      if (
        ["json_api", "form_webhook"].includes(row.provider) &&
        !ctx.entitlements.includes("clients")
      )
        throw new ForbiddenException("Contact sources require the CRM feature");
      const credentials =
        patch.credentials ??
        (row.credentials_encrypted
          ? decrypt(row.credentials_encrypted, ctx.businessId)
          : {});
      const config = patch.config ?? row.config;
      parseBody(connectionSchema, {
        provider: row.provider,
        displayName: patch.displayName ?? row.display_name,
        credentials,
        config,
      });
      let account: Record<string, unknown>;
      try {
        account = await validateAccount(
          row.provider,
          credentials.token,
          config,
        );
      } catch (error) {
        throw new BadGatewayException(message(error));
      }
      const changed = (
        await tx.query<Row>(
          `UPDATE integration_connections SET display_name=$3,config=$4,credentials_encrypted=$5,account=$6,dispatch_entitlements=$7,status='connected',last_error=NULL,updated_at=now(),next_sync_at=CASE WHEN provider='form_webhook' THEN NULL ELSE now() END WHERE business_id=$1 AND id=$2 RETURNING *`,
          [
            ctx.businessId,
            id,
            patch.displayName ?? row.display_name,
            JSON.stringify(config),
            row.provider === "form_webhook"
              ? null
              : encrypt(credentials, ctx.businessId),
            JSON.stringify(account),
            ctx.entitlements,
          ],
        )
      ).rows[0]!;
      return { item: view(changed) };
    });
  }
  async disconnect(ctx: RequestContext, id: string) {
    parseBody(uuid, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<Row>(
          `UPDATE integration_connections SET status='disconnected',credentials_encrypted=NULL,webhook_secret_hash=NULL,next_sync_at=NULL,last_error=NULL,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Connection not found");
      await emitEvent(tx, {
        type: "integrations.connection-disconnected.v1",
        producer: "integrations",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { connectionId: id },
      });
      return { item: view(row) };
    });
  }
  private async publish(
    tx: PoolClient,
    row: Row,
    result: SyncData,
    correlationId?: string,
  ) {
    if (row.dispatch_entitlements.includes("clients"))
      for (let offset = 0; offset < result.contacts.length; offset += 200)
        await emitEvent(tx, {
          type: "integrations.contacts-received.v1",
          producer: "integrations",
          businessId: row.business_id,
          correlationId,
          data: {
            connectionId: row.id,
            source: row.provider,
            contacts: result.contacts.slice(offset, offset + 200),
          },
        });
    if (row.dispatch_entitlements.includes("scheduling"))
      for (let offset = 0; offset < result.sessions.length; offset += 200)
        await emitEvent(tx, {
          type: "integrations.sessions-synced.v1",
          producer: "integrations",
          businessId: row.business_id,
          correlationId,
          data: {
            connectionId: row.id,
            provider: row.provider,
            ownerUserId: row.created_by,
            sessions: result.sessions.slice(offset, offset + 200),
          },
        });
  }
  async sync(ctx: RequestContext, id: string) {
    parseBody(uuid, id);
    const result = await this.syncTenant(
      ctx.businessId,
      id,
      true,
      ctx.requestId,
      ctx.entitlements,
    );
    if (!result)
      throw new ConflictException(
        "Synchronization already running or connection is disconnected",
      );
    if (result.status === "error") throw new BadGatewayException(result.error);
    return result;
  }
  private async syncTenant(
    businessId: string,
    id: string,
    force = false,
    requestId?: string,
    entitlements?: string[],
  ) {
    return this.db.withTenant(businessId, async (tx) => {
      const locked = await tx.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
        [`integrations:${businessId}:${id}`],
      );
      if (!locked.rows[0]?.locked) return null;
      const row = (
        await tx.query<Row>(
          "SELECT * FROM integration_connections WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [businessId, id],
        )
      ).rows[0];
      if (!row) {
        if (force) throw new NotFoundException("Connection not found");
        return null;
      }
      if (row.status === "disconnected") return null;
      if (entitlements) {
        row.dispatch_entitlements = entitlements;
        await tx.query(
          "UPDATE integration_connections SET dispatch_entitlements=$3 WHERE business_id=$1 AND id=$2",
          [businessId, id, entitlements],
        );
      }
      if (!row.dispatch_entitlements.includes("integrations")) return null;
      if (
        row.provider === "json_api" &&
        !row.dispatch_entitlements.includes("clients")
      )
        throw new ForbiddenException("Contact sources require the CRM feature");
      if (row.provider === "form_webhook")
        throw new ConflictException(
          "Form connections receive contacts through their webhook",
        );
      if (!force && row.next_sync_at && row.next_sync_at.getTime() > Date.now())
        return null;
      await tx.query(
        "UPDATE integration_connections SET last_attempt_at=now() WHERE business_id=$1 AND id=$2",
        [businessId, id],
      );
      let result: SyncData;
      try {
        const credentials = decrypt(row.credentials_encrypted!, businessId);
        result = await pull(
          row.provider,
          credentials.token,
          row.config,
          row.account,
        );
      } catch (error) {
        const safe = message(error);
        await tx.query(
          `UPDATE integration_connections SET status='error',last_error=$3,next_sync_at=now()+interval '5 minutes',updated_at=now() WHERE business_id=$1 AND id=$2`,
          [businessId, id, safe],
        );
        return { connectionId: id, status: "error", error: safe };
      }
      await this.publish(tx, row, result, requestId);
      const counts = {
        contactsReceived: result.contacts.length,
        sessionsSynced: result.sessions.length,
        contactsDispatched: row.dispatch_entitlements.includes("clients")
          ? result.contacts.length
          : 0,
        sessionsDispatched: row.dispatch_entitlements.includes("scheduling")
          ? result.sessions.length
          : 0,
        truncated: result.truncated,
      };
      const updated = (
        await tx.query<{ last_sync_at: Date }>(
          `UPDATE integration_connections SET status='connected',last_error=NULL,last_sync_at=now(),next_sync_at=now()+interval '5 minutes',sync_counts=$3,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING last_sync_at`,
          [businessId, id, JSON.stringify(counts)],
        )
      ).rows[0]!;
      return {
        connectionId: id,
        status: result.truncated ? "partial" : "synced",
        ...counts,
        syncedAt: updated.last_sync_at.toISOString(),
      };
    });
  }
  async receive(
    businessId: string,
    id: string,
    authorization: unknown,
    body: unknown,
  ) {
    parseBody(uuid, businessId);
    parseBody(uuid, id);
    const secret =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    if (!secret || secret.length > 200)
      throw new UnauthorizedException("Invalid webhook credential");
    return this.db.withTenant(businessId, async (tx) => {
      const row = (
        await tx.query<Row>(
          "SELECT * FROM integration_connections WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [businessId, id],
        )
      ).rows[0];
      const expected = Buffer.from(
        row?.webhook_secret_hash ?? "0".repeat(64),
        "hex",
      );
      const supplied = Buffer.from(hashSecret(secret), "hex");
      if (
        !timingSafeEqual(expected, supplied) ||
        !row ||
        row.provider !== "form_webhook" ||
        row.status === "disconnected"
      )
        throw new UnauthorizedException("Invalid webhook credential");
      if (
        !row.dispatch_entitlements.includes("integrations") ||
        !row.dispatch_entitlements.includes("clients")
      )
        throw new ForbiddenException(
          "Contact sources require the CRM and integrations features",
        );
      let result: ReturnType<typeof mappedContacts>;
      try {
        result = mappedContacts(body, row.config, true);
      } catch (error) {
        throw new ConflictException(message(error));
      }
      await this.publish(tx, row, { ...result, sessions: [] });
      const counts = {
        contactsReceived: result.contacts.length,
        sessionsSynced: 0,
        truncated: result.truncated,
      };
      await tx.query(
        `UPDATE integration_connections SET status='connected',last_attempt_at=now(),last_sync_at=now(),last_error=NULL,sync_counts=$3,updated_at=now() WHERE business_id=$1 AND id=$2`,
        [businessId, id, JSON.stringify(counts)],
      );
      return { accepted: true, ...counts };
    });
  }
  private async poll() {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      const tenants = (
        await this.db.pool.query<{ business_id: string }>(
          "SELECT business_id FROM integration_tenant_directory WHERE business_id::text > $1 ORDER BY business_id::text LIMIT 25",
          [this.businessCursor],
        )
      ).rows;
      if (!tenants.length) {
        this.businessCursor = "";
        return;
      }
      for (const tenant of tenants) {
        if (this.stopping) break;
        this.businessCursor = tenant.business_id;
        const ids = await this.db.withTenant(
          tenant.business_id,
          async (tx) =>
            (
              await tx.query<{ id: string }>(
                `SELECT id FROM integration_connections WHERE business_id=$1 AND status <> 'disconnected' AND provider <> 'form_webhook' AND next_sync_at<=now() ORDER BY next_sync_at LIMIT 50`,
                [tenant.business_id],
              )
            ).rows,
        );
        for (const row of ids) {
          if (this.stopping) break;
          await this.syncTenant(tenant.business_id, row.id).catch(() => {});
        }
      }
    } catch {
      console.warn("[integrations] poll unavailable; retrying");
    } finally {
      this.polling = false;
    }
  }
}
@ApiTags("connections")
@Roles("owner", "admin", "tutor")
@Controller("v1/connections")
export class ConnectionsController {
  constructor(
    @Inject(ConnectionsService) private readonly service: ConnectionsService,
  ) {}
  @Get() list(@CurrentContext() ctx: RequestContext) {
    return this.service.list(ctx);
  }
  @Get(":id") one(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
  ) {
    return this.service.one(ctx, id);
  }
  @Roles("owner", "admin") @Post() create(
    @CurrentContext() ctx: RequestContext,
    @Body() body: unknown,
  ) {
    return this.service.create(ctx, body);
  }
  @Roles("owner", "admin") @Patch(":id") update(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.update(ctx, id, body);
  }
  @Roles("owner", "admin") @Post(":id/sync") sync(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
  ) {
    return this.service.sync(ctx, id);
  }
  @Roles("owner", "admin") @Delete(":id") disconnect(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
  ) {
    return this.service.disconnect(ctx, id);
  }
}
@Public()
@Controller("hooks")
export class FormHooksController {
  constructor(
    @Inject(ConnectionsService) private readonly service: ConnectionsService,
  ) {}
  @Post(":businessId/:connectionId") receive(
    @Param("businessId") businessId: string,
    @Param("connectionId") id: string,
    @Headers("authorization") authorization: unknown,
    @Body() body: unknown,
  ) {
    return this.service.receive(businessId, id, authorization, body);
  }
}
