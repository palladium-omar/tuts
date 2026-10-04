import { createHash, randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
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
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  CurrentContext,
  Database,
  emitEvent,
  parseBody,
  Roles,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import type { PoolClient } from "pg";
import {
  campaignSchema,
  connectionPatchSchema,
  connectionSchema,
  eligibility,
  generateSchema,
  generatedSchema,
  personalize,
  recipientsSchema,
  sendSchema,
} from "./communication-schemas.js";
import {
  CommunicationError,
  decryptCredentials,
  deliveryEnabled,
  encryptCredentials,
  httpsEndpoint,
  resolvePublicHost,
  safeJsonPost,
} from "./communication-security.js";
import { uuid } from "./schemas.js";
export type ConnectionRow = {
  id: string;
  business_id: string;
  provider: string;
  display_name: string;
  config: Record<string, any>;
  credentials_encrypted: string;
  status: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
};
export type CampaignRow = {
  id: string;
  business_id: string;
  connection_id: string;
  connection_revision: number;
  channel: "email" | "whatsapp";
  subject: string;
  message: string;
  template: any;
  selection: unknown;
  status: string;
  created_by: string;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
export type RecipientRow = {
  id: string;
  client_id: string;
  display_name: string;
  address: string | null;
  subject: string;
  message: string;
  template: any;
  status: string;
  reason: string | null;
  provider_message_id: string | null;
  accepted_at: Date | null;
};
export const requireManager = (ctx: RequestContext) => {
  if (ctx.role !== "owner" && ctx.role !== "admin")
    throw new ForbiddenException(
      "Only owners and admins can manage communications",
    );
};
export const connectionView = (row: ConnectionRow) => ({
  id: row.id,
  provider: row.provider,
  displayName: row.display_name,
  config: row.config,
  status: row.status,
  revision: row.revision,
  credentialsConfigured: true,
  verificationStatus: "not_verified",
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
export const recipientView = (row: RecipientRow) => ({
  id: row.id,
  clientId: row.client_id,
  displayName: row.display_name,
  address: row.address,
  subject: row.subject,
  message: row.message,
  template: row.template,
  status: row.status,
  reason: row.reason,
  providerMessageId: row.provider_message_id,
  acceptedAt: row.accepted_at?.toISOString() ?? null,
});
export function confirmationToken(
  campaign: CampaignRow,
  recipients: RecipientRow[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: campaign.id,
        businessId: campaign.business_id,
        connectionId: campaign.connection_id,
        connectionRevision: campaign.connection_revision,
        channel: campaign.channel,
        subject: campaign.subject,
        message: campaign.message,
        template: campaign.template,
        recipients: recipients.map((r) => ({
          id: r.id,
          clientId: r.client_id,
          address: r.address,
          subject: r.subject,
          message: r.message,
          template: r.template,
          eligible: r.status !== "skipped",
          skipReason: r.status === "skipped" ? r.reason : null,
        })),
      }),
    )
    .digest("hex");
}
async function campaignRecipients(
  tx: PoolClient,
  businessId: string,
  id: string,
  lock = false,
) {
  return (
    await tx.query<RecipientRow>(
      "SELECT * FROM communication_recipients WHERE business_id=$1 AND campaign_id=$2 ORDER BY id" +
        (lock ? " FOR UPDATE" : ""),
      [businessId, id],
    )
  ).rows;
}
export function campaignView(row: CampaignRow, recipients: RecipientRow[]) {
  const counts: Record<string, number> = {
    pending: 0,
    sending: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
  };
  for (const r of recipients) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    id: row.id,
    connectionId: row.connection_id,
    channel: row.channel,
    subject: row.subject,
    message: row.message,
    template: row.template,
    selection: row.selection,
    status: row.status,
    counts,
    totalRecipients: recipients.length,
    eligibleRecipients: recipients.filter(
      (r) => r.address !== null && r.status !== "skipped",
    ).length,
    confirmationToken: confirmationToken(row, recipients),
    approvedAt: row.approved_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
/** Only the configured clients service is contacted; caller's short-lived signed context is forwarded. */
export async function resolveRecipients(
  selection: unknown,
  authorization: string,
) {
  if (!authorization.startsWith("Bearer "))
    throw new ForbiddenException("Verified caller context is required");
  const base = process.env.CLIENTS_URL;
  if (!base) throw new BadGatewayException("Clients service is not configured");
  let url: URL;
  try {
    url = new URL("/v1/recipients", base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    throw new BadGatewayException("Clients service URL is invalid");
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(selection),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new BadGatewayException(
        "The CRM recipient selection could not be resolved",
      );
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = recipientsSchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString()),
    );
    if (!result.success) throw new Error();
    if (result.data.truncated || result.data.total > 2000)
      throw new BadRequestException(
        "Selection exceeds 2000 contacts; narrow the filter",
      );
    return result.data.items;
  } catch (e) {
    if (e instanceof BadRequestException || e instanceof BadGatewayException)
      throw e;
    throw new BadGatewayException(
      "The CRM recipient selection could not be resolved",
    );
  }
}
@Injectable()
export class CommunicationsService {
  constructor(
    @Inject(Database)
    private readonly db: Database,
  ) {}
  async listConnections(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) => ({
      items: (
        await tx.query<ConnectionRow>(
          "SELECT * FROM communication_connections WHERE business_id=$1 ORDER BY created_at DESC",
          [ctx.businessId],
        )
      ).rows.map(connectionView),
      deliveryEnabled: deliveryEnabled(),
    }));
  }
  async createConnection(ctx: RequestContext, body: unknown) {
    requireManager(ctx);
    const v = parseBody(connectionSchema, body);
    try {
      if (v.provider === "smtp") await resolvePublicHost(v.config.host);
      if (v.provider === "ai_agent") {
        const url = httpsEndpoint(v.config.endpointUrl);
        await resolvePublicHost(url.hostname.replace(/^\[|\]$/g, ""));
      }
      const encrypted = encryptCredentials(v.credentials, ctx.businessId);
      return this.db.withTenant(ctx.businessId, async (tx) => {
        const row = (
          await tx.query<ConnectionRow>(
            "INSERT INTO communication_connections(id,business_id,provider,display_name,config,credentials_encrypted,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              ctx.businessId,
              v.provider,
              v.displayName,
              JSON.stringify(v.config),
              encrypted,
              ctx.sub,
            ],
          )
        ).rows[0]!;
        await emitEvent(tx, {
          type: "notifications.connection-created.v1",
          producer: "notifications",
          businessId: ctx.businessId,
          correlationId: ctx.requestId,
          data: { connectionId: row.id, provider: row.provider },
        });
        return {
          item: connectionView(row),
          deliveryEnabled: deliveryEnabled(),
        };
      });
    } catch (e) {
      if (e instanceof CommunicationError)
        throw new BadRequestException(e.safeMessage);
      throw e;
    }
  }
  async patchConnection(ctx: RequestContext, id: string, body: unknown) {
    requireManager(ctx);
    parseBody(uuid, id);
    const patch = parseBody(connectionPatchSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<ConnectionRow>(
          "SELECT * FROM communication_connections WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Connection not found");
      try {
        let config = row.config,
          encrypted = row.credentials_encrypted;
        if (patch.config || patch.credentials) {
          const v = parseBody(connectionSchema, {
            provider: row.provider,
            displayName: patch.displayName ?? row.display_name,
            config: patch.config ?? row.config,
            credentials:
              patch.credentials ??
              decryptCredentials(row.credentials_encrypted, ctx.businessId),
          });
          if (v.provider === "smtp") await resolvePublicHost(v.config.host);
          if (v.provider === "ai_agent") {
            const u = httpsEndpoint(v.config.endpointUrl);
            await resolvePublicHost(u.hostname.replace(/^\[|\]$/g, ""));
          }
          config = v.config;
          encrypted = encryptCredentials(v.credentials, ctx.businessId);
        }
        const updated = (
          await tx.query<ConnectionRow>(
            "UPDATE communication_connections SET display_name=$3,config=$4,credentials_encrypted=$5,status=$6,revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
            [
              ctx.businessId,
              id,
              patch.displayName ?? row.display_name,
              JSON.stringify(config),
              encrypted,
              patch.status ?? row.status,
            ],
          )
        ).rows[0]!;
        await tx.query(
          "UPDATE communication_recipients r SET status='skipped',reason='connection_changed',updated_at=now() FROM communication_campaigns c WHERE r.business_id=$1 AND c.business_id=r.business_id AND c.id=r.campaign_id AND c.connection_id=$2 AND c.status='queued' AND r.status='pending'",
          [ctx.businessId, id],
        );
        await emitEvent(tx, {
          type: "notifications.connection-updated.v1",
          producer: "notifications",
          businessId: ctx.businessId,
          correlationId: ctx.requestId,
          data: { connectionId: id, status: updated.status },
        });
        return {
          item: connectionView(updated),
          deliveryEnabled: deliveryEnabled(),
        };
      } catch (e) {
        if (e instanceof CommunicationError)
          throw new BadRequestException(e.safeMessage);
        throw e;
      }
    });
  }
  async disableConnection(ctx: RequestContext, id: string) {
    return this.patchConnection(ctx, id, { status: "disabled" });
  }
  async generate(ctx: RequestContext, id: string, body: unknown) {
    parseBody(uuid, id);
    const v = parseBody(generateSchema, body);
    const row = await this.db.withTenant(
      ctx.businessId,
      async (tx) =>
        (
          await tx.query<ConnectionRow>(
            "SELECT * FROM communication_connections WHERE business_id=$1 AND id=$2",
            [ctx.businessId, id],
          )
        ).rows[0],
    );
    if (!row) throw new NotFoundException("Connection not found");
    if (row.provider !== "ai_agent" || row.status !== "active")
      throw new ConflictException("An active AI agent connection is required");
    try {
      const credentials = decryptCredentials(
        row.credentials_encrypted,
        ctx.businessId,
      );
      const response = await safeJsonPost(
        row.config.endpointUrl,
        {
          instruction: v.instruction,
          subject: v.subject ?? "",
          message: v.message ?? "",
        },
        credentials.bearerToken
          ? { Authorization: `Bearer ${credentials.bearerToken}` }
          : {},
      );
      const parsed = generatedSchema.safeParse(response);
      if (!parsed.success)
        throw new CommunicationError(
          "AI endpoint must return a subject and message",
        );
      return { item: parsed.data };
    } catch (e) {
      throw new BadGatewayException(
        e instanceof CommunicationError ? e.safeMessage : "AI drafting failed",
      );
    }
  }
  async createCampaign(
    ctx: RequestContext,
    body: unknown,
    authorization: string,
  ) {
    requireManager(ctx);
    const v = parseBody(campaignSchema, body);
    const contacts = await resolveRecipients(v.selection, authorization);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const connection = (
        await tx.query<ConnectionRow>(
          "SELECT * FROM communication_connections WHERE business_id=$1 AND id=$2 FOR SHARE",
          [ctx.businessId, v.connectionId],
        )
      ).rows[0];
      if (!connection) throw new NotFoundException("Connection not found");
      if (
        connection.status !== "active" ||
        !(v.channel === "email"
          ? ["smtp", "resend"].includes(connection.provider)
          : connection.provider === "whatsapp_business")
      )
        throw new ConflictException(
          "Choose an active connection for this channel",
        );
      const campaign = (
        await tx.query<CampaignRow>(
          "INSERT INTO communication_campaigns(id,business_id,connection_id,connection_revision,channel,subject,message,template,selection,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            randomUUID(),
            ctx.businessId,
            connection.id,
            connection.revision,
            v.channel,
            v.subject ?? "",
            v.message ?? "",
            v.template ? JSON.stringify(v.template) : null,
            JSON.stringify(v.selection),
            ctx.sub,
          ],
        )
      ).rows[0]!;
      const seenClients = new Set<string>(),
        seenAddresses = new Set<string>();
      const consent = (
        await tx.query<{
          client_id: string;
          email_opt_in: boolean | null;
          whatsapp_opt_in: boolean | null;
        }>(
          "SELECT * FROM communication_consent WHERE business_id=$1 AND client_id=ANY($2::uuid[])",
          [ctx.businessId, contacts.map((c) => c.id)],
        )
      ).rows;
      const revoked = new Map(consent.map((c) => [c.client_id, c]));
      for (const contact of contacts) {
        if (seenClients.has(contact.id)) continue;
        seenClients.add(contact.id);
        const eligible = eligibility(contact, v.channel);
        const suppression = revoked.get(contact.id);
        if (
          (v.channel === "email"
            ? suppression?.email_opt_in
            : suppression?.whatsapp_opt_in) === false
        ) {
          eligible.reason = "consent_revoked";
          eligible.address = null;
        }
        const key = eligible.address?.toLowerCase();
        if (key && seenAddresses.has(key)) {
          eligible.reason = "duplicate_address";
          eligible.address = null;
        }
        if (key) seenAddresses.add(key);
        let subject = "",
          message = "",
          template = null;
        try {
          subject = personalize(v.subject ?? "", contact);
          message = personalize(v.message ?? "", contact);
          template = v.template
            ? {
                ...v.template,
                parameters: v.template.parameters.map((p) =>
                  personalize(p, contact),
                ),
              }
            : null;
          if (
            subject.length > 200 ||
            /[\r\n]/.test(subject) ||
            message.length > 10000 ||
            template?.parameters.some((p) => p.length > 2000)
          )
            throw new Error();
        } catch {
          throw new BadRequestException(
            "Invalid or oversized personalized content",
          );
        }
        await tx.query(
          "INSERT INTO communication_recipients(id,business_id,campaign_id,client_id,display_name,address,subject,message,template,status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            randomUUID(),
            ctx.businessId,
            campaign.id,
            contact.id,
            contact.displayName,
            eligible.address,
            subject,
            message,
            template ? JSON.stringify(template) : null,
            eligible.reason ? "skipped" : "pending",
            eligible.reason,
          ],
        );
      }
      await emitEvent(tx, {
        type: "notifications.campaign-created.v1",
        producer: "notifications",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { campaignId: campaign.id },
      });
      const recipients = await campaignRecipients(
        tx,
        ctx.businessId,
        campaign.id,
      );
      return {
        item: campaignView(campaign, recipients),
        recipients: recipients.map(recipientView),
        deliveryEnabled: deliveryEnabled(),
      };
    });
  }
  async listCampaigns(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const rows = (
        await tx.query<CampaignRow>(
          "SELECT * FROM communication_campaigns WHERE business_id=$1 ORDER BY created_at DESC LIMIT 100",
          [ctx.businessId],
        )
      ).rows;
      const items = [];
      for (const row of rows)
        items.push(
          campaignView(
            row,
            await campaignRecipients(tx, ctx.businessId, row.id),
          ),
        );
      return { items, deliveryEnabled: deliveryEnabled() };
    });
  }
  async getCampaign(ctx: RequestContext, id: string) {
    parseBody(uuid, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<CampaignRow>(
          "SELECT * FROM communication_campaigns WHERE business_id=$1 AND id=$2",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Campaign not found");
      const recipients = await campaignRecipients(tx, ctx.businessId, id);
      return {
        item: campaignView(row, recipients),
        recipients: recipients.map(recipientView),
        deliveryEnabled: deliveryEnabled(),
      };
    });
  }
  async sendCampaign(ctx: RequestContext, id: string, body: unknown) {
    requireManager(ctx);
    parseBody(uuid, id);
    const v = parseBody(sendSchema, body);
    if (!deliveryEnabled())
      throw new ConflictException("Outbound delivery is disabled");
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<CampaignRow>(
          "SELECT * FROM communication_campaigns WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Campaign not found");
      const recipients = await campaignRecipients(tx, ctx.businessId, id, true);
      if (v.confirmationToken !== confirmationToken(row, recipients))
        throw new ConflictException(
          "Campaign preview changed; review it again",
        );
      if (row.status === "queued" || row.status === "completed")
        return { item: campaignView(row, recipients) };
      if (row.status !== "draft")
        throw new ConflictException("Campaign is not a draft");
      const conn = (
        await tx.query<ConnectionRow>(
          "SELECT * FROM communication_connections WHERE business_id=$1 AND id=$2 FOR SHARE",
          [ctx.businessId, row.connection_id],
        )
      ).rows[0];
      if (
        !conn ||
        conn.status !== "active" ||
        conn.revision !== row.connection_revision
      )
        throw new ConflictException(
          "Connection changed; create and review a new draft",
        );
      if (!recipients.some((r) => r.status === "pending"))
        throw new ConflictException("No eligible opted-in recipients");
      const updated = (
        await tx.query<CampaignRow>(
          "UPDATE communication_campaigns SET status='queued',approved_by=$3,approved_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
          [ctx.businessId, id, ctx.sub],
        )
      ).rows[0]!;
      await emitEvent(tx, {
        type: "notifications.campaign-queued.v1",
        producer: "notifications",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { campaignId: id },
      });
      return { item: campaignView(updated, recipients) };
    });
  }
  async cancelCampaign(ctx: RequestContext, id: string) {
    requireManager(ctx);
    parseBody(uuid, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<CampaignRow>(
          "SELECT * FROM communication_campaigns WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Campaign not found");
      if (row.status === "completed")
        throw new ConflictException("Campaign has completed");
      await tx.query(
        "UPDATE communication_recipients SET status='skipped',reason='campaign_cancelled',updated_at=now() WHERE business_id=$1 AND campaign_id=$2 AND status='pending'",
        [ctx.businessId, id],
      );
      const updated = (
        await tx.query<CampaignRow>(
          "UPDATE communication_campaigns SET status='cancelled',updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
          [ctx.businessId, id],
        )
      ).rows[0]!;
      await emitEvent(tx, {
        type: "notifications.campaign-cancelled.v1",
        producer: "notifications",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { campaignId: id },
      });
      return {
        item: campaignView(
          updated,
          await campaignRecipients(tx, ctx.businessId, id),
        ),
      };
    });
  }
}
@ApiTags("communication-connections")
@Roles("owner", "admin", "tutor")
@Controller("v1/communication-connections")
export class CommunicationConnectionsController {
  constructor(
    @Inject(CommunicationsService)
    private readonly service: CommunicationsService,
  ) {}
  @Get()
  list(
    @CurrentContext()
    ctx: RequestContext,
  ) {
    return this.service.listConnections(ctx);
  }
  @Roles("owner", "admin")
  @Post()
  create(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
  ) {
    return this.service.createConnection(ctx, body);
  }
  @Roles("owner", "admin")
  @Patch(":id")
  patch(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
    @Body()
    body: unknown,
  ) {
    return this.service.patchConnection(ctx, id, body);
  }
  @Roles("owner", "admin")
  @Delete(":id")
  disable(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
  ) {
    return this.service.disableConnection(ctx, id);
  }
  @Post(":id/generate")
  generate(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
    @Body()
    body: unknown,
  ) {
    return this.service.generate(ctx, id, body);
  }
}
@ApiTags("campaigns")
@Roles("owner", "admin", "tutor")
@Controller("v1/campaigns")
export class CampaignsController {
  constructor(
    @Inject(CommunicationsService)
    private readonly service: CommunicationsService,
  ) {}
  @Get()
  list(
    @CurrentContext()
    ctx: RequestContext,
  ) {
    return this.service.listCampaigns(ctx);
  }
  @Get(":id")
  get(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
  ) {
    return this.service.getCampaign(ctx, id);
  }
  @Roles("owner", "admin")
  @Post()
  create(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
    @Headers("authorization")
    authorization: string,
  ) {
    return this.service.createCampaign(ctx, body, authorization ?? "");
  }
  @Roles("owner", "admin")
  @Post(":id/send")
  send(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
    @Body()
    body: unknown,
  ) {
    return this.service.sendCampaign(ctx, id, body);
  }
  @Roles("owner", "admin")
  @Post(":id/cancel")
  cancel(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
  ) {
    return this.service.cancelCampaign(ctx, id);
  }
}
