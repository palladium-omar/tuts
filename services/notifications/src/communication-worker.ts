import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Database, EventBus } from "@palladium/service-kit";
import type { PoolClient } from "pg";
import { consentSchema } from "./communication-schemas.js";
import {
  CommunicationError,
  decryptCredentials,
  deliveryEnabled,
} from "./communication-security.js";
import { deliver } from "./communication-providers.js";
import type {
  CampaignRow,
  ConnectionRow,
  RecipientRow,
} from "./communications.js";
type Leased = RecipientRow & {
  campaign_id: string;
  lease_token: string;
};
/** Shared event inbox handles dedup. Ordered consent state suppresses pending recipients, never rewrites accepted history. */
export async function applyConsent(
  event: {
    businessId: string;
    occurredAt: string;
    data: unknown;
  },
  tx: PoolClient,
) {
  const data = consentSchema.parse(event.data);
  const updated = await tx.query(
    `INSERT INTO communication_consent(business_id,client_id,email_opt_in,whatsapp_opt_in,event_occurred_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_id,client_id) DO UPDATE SET email_opt_in=coalesce(EXCLUDED.email_opt_in,communication_consent.email_opt_in),whatsapp_opt_in=coalesce(EXCLUDED.whatsapp_opt_in,communication_consent.whatsapp_opt_in),event_occurred_at=EXCLUDED.event_occurred_at WHERE communication_consent.event_occurred_at <= EXCLUDED.event_occurred_at RETURNING *`,
    [
      event.businessId,
      data.clientId,
      data.emailOptIn ?? null,
      data.whatsappOptIn ?? null,
      event.occurredAt,
    ],
  );
  if (!updated.rowCount) return;
  await tx.query(
    `UPDATE communication_recipients r SET status='skipped',reason='consent_revoked',updated_at=now() FROM communication_campaigns c WHERE r.business_id=$1 AND r.client_id=$2 AND r.status='pending' AND c.business_id=r.business_id AND c.id=r.campaign_id AND ((c.channel='email' AND $3::boolean=false) OR (c.channel='whatsapp' AND $4::boolean=false))`,
    [
      event.businessId,
      data.clientId,
      data.emailOptIn ?? null,
      data.whatsappOptIn ?? null,
    ],
  );
}
@Injectable()
export class CommunicationWorker implements OnModuleInit, OnModuleDestroy {
  private interval?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private cursor = "";
  constructor(
    @Inject(Database)
    private readonly db: Database,
    @Inject(EventBus)
    private readonly events: EventBus,
  ) {}
  onModuleInit() {
    for (const type of [
      "clients.client-created.v1",
      "clients.client-updated.v1",
    ])
      this.events.subscribe(type, (event, tx) => {
        if (event.producer !== "clients")
          throw new Error("consent_producer_invalid");
        return applyConsent(event, tx);
      });
    this.interval = setInterval(() => void this.tick(), 2000);
    this.interval.unref();
  }
  onModuleDestroy() {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
  }
  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      // The shared outbox holds routing metadata. Domain tables are always queried with tenant RLS.
      let tenants = (
        await this.db.pool.query<{
          business_id: string;
        }>(
          `SELECT DISTINCT event->>'businessId' AS business_id FROM service_outbox WHERE event->>'type'='notifications.campaign-queued.v1' AND event->>'producer'='notifications' AND event->>'businessId'>$1 ORDER BY business_id LIMIT 10`,
          [this.cursor],
        )
      ).rows;
      if (!tenants.length && this.cursor) {
        this.cursor = "";
        tenants = (
          await this.db.pool.query<{
            business_id: string;
          }>(
            `SELECT DISTINCT event->>'businessId' AS business_id FROM service_outbox WHERE event->>'type'='notifications.campaign-queued.v1' AND event->>'producer'='notifications' ORDER BY business_id LIMIT 10`,
          )
        ).rows;
      }
      for (const tenant of tenants) {
        if (this.stopping) break;
        this.cursor = tenant.business_id;
        await this.processTenant(tenant.business_id);
      }
    } catch {
      console.warn(
        "[notifications] communication queue pass could not complete",
      );
    } finally {
      this.busy = false;
    }
  }
  async processTenant(businessId: string) {
    const lease = await this.db.withTenant(businessId, async (tx) => {
      // Any expired lease can have crossed the provider acceptance boundary. It must never be resent automatically.
      await tx.query(
        "UPDATE communication_recipients SET status='unknown',reason='lease_expired_acceptance_unknown',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=$1 AND status='sending' AND lease_until<now()",
        [businessId],
      );
      await tx.query(
        "UPDATE communication_campaigns c SET status='completed',updated_at=now() WHERE c.business_id=$1 AND c.status='queued' AND NOT EXISTS(SELECT 1 FROM communication_recipients r WHERE r.business_id=c.business_id AND r.campaign_id=c.id AND r.status IN ('pending','sending'))",
        [businessId],
      );
      if (!deliveryEnabled()) return null;
      const campaign = (
        await tx.query<CampaignRow>(
          "SELECT * FROM communication_campaigns c WHERE business_id=$1 AND status='queued' AND EXISTS(SELECT 1 FROM communication_recipients r WHERE r.business_id=c.business_id AND r.campaign_id=c.id AND r.status='pending') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
          [businessId],
        )
      ).rows[0];
      if (!campaign) return null;
      const conn = (
        await tx.query<ConnectionRow>(
          "SELECT * FROM communication_connections WHERE business_id=$1 AND id=$2 FOR SHARE",
          [businessId, campaign.connection_id],
        )
      ).rows[0];
      if (
        !conn ||
        conn.status !== "active" ||
        conn.revision !== campaign.connection_revision
      ) {
        await tx.query(
          "UPDATE communication_recipients SET status='skipped',reason='connection_changed',updated_at=now() WHERE business_id=$1 AND campaign_id=$2 AND status='pending'",
          [businessId, campaign.id],
        );
        return null;
      }
      await tx.query(
        `UPDATE communication_recipients r SET status='skipped',reason='consent_revoked',updated_at=now() FROM communication_consent s WHERE r.business_id=$1 AND r.campaign_id=$2 AND r.status='pending' AND s.business_id=r.business_id AND s.client_id=r.client_id AND (($3='email' AND s.email_opt_in=false) OR ($3='whatsapp' AND s.whatsapp_opt_in=false))`,
        [businessId, campaign.id, campaign.channel],
      );
      const recipient = (
        await tx.query<Leased>(
          "SELECT * FROM communication_recipients WHERE business_id=$1 AND campaign_id=$2 AND status='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
          [businessId, campaign.id],
        )
      ).rows[0];
      if (!recipient) return null;
      const token = randomUUID();
      await tx.query(
        "UPDATE communication_recipients SET status='sending',lease_token=$3,lease_until=now()+interval '60 seconds',attempted_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2",
        [businessId, recipient.id, token],
      );
      return {
        recipient: { ...recipient, lease_token: token },
        connection: conn,
        campaign,
      };
    });
    if (!lease) return;
    let status = "unknown",
      reason: string | null = "acceptance_unknown",
      providerId: string | null = null;
    try {
      const valid = await this.db.withTenant(businessId, async (tx) => {
        const row = (
          await tx.query<{
            status: string;
            revision: number;
            campaign_status: string;
            email_opt_in: boolean | null;
            whatsapp_opt_in: boolean | null;
          }>(
            `SELECT x.status,x.revision,c.status AS campaign_status,s.email_opt_in,s.whatsapp_opt_in FROM communication_connections x JOIN communication_campaigns c ON c.business_id=x.business_id AND c.connection_id=x.id LEFT JOIN communication_consent s ON s.business_id=c.business_id AND s.client_id=$3 WHERE c.business_id=$1 AND c.id=$2`,
            [businessId, lease.campaign.id, lease.recipient.client_id],
          )
        ).rows[0];
        return (
          deliveryEnabled() &&
          row?.status === "active" &&
          row.revision === lease.campaign.connection_revision &&
          row.campaign_status === "queued" &&
          (lease.campaign.channel === "email"
            ? row.email_opt_in
            : row.whatsapp_opt_in) !== false
        );
      });
      if (!valid) {
        status = "skipped";
        reason = "authorization_or_consent_changed";
      } else {
        providerId = await deliver(
          {
            provider: lease.connection.provider,
            config: lease.connection.config,
            credentials: decryptCredentials(
              lease.connection.credentials_encrypted,
              businessId,
            ),
          },
          {
            id: lease.recipient.id,
            address: lease.recipient.address!,
            subject: lease.recipient.subject,
            message: lease.recipient.message,
            template: lease.recipient.template,
          },
        );
        status = "accepted";
        reason = null;
      }
    } catch (e) {
      const error =
        e instanceof CommunicationError
          ? e
          : new CommunicationError("Provider acceptance is unknown", true);
      status = error.ambiguous ? "unknown" : "failed";
      reason = error.safeMessage;
    }
    await this.db.withTenant(businessId, async (tx) => {
      // A slow response may arrive just after another worker recovers the expired lease. Preserve a verified provider ID.
      await tx.query(
        "UPDATE communication_recipients SET status=$4,reason=$5,provider_message_id=coalesce($6,provider_message_id),accepted_at=CASE WHEN $4='accepted' THEN now() ELSE accepted_at END,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=$1 AND id=$2 AND ((status='sending' AND lease_token=$3) OR (status='unknown' AND reason='lease_expired_acceptance_unknown' AND $4='accepted'))",
        [
          businessId,
          lease.recipient.id,
          lease.recipient.lease_token,
          status,
          reason,
          providerId,
        ],
      );
      await tx.query(
        "UPDATE communication_campaigns c SET status='completed',updated_at=now() WHERE business_id=$1 AND id=$2 AND status='queued' AND NOT EXISTS(SELECT 1 FROM communication_recipients r WHERE r.business_id=c.business_id AND r.campaign_id=c.id AND r.status IN ('pending','sending'))",
        [businessId, lease.campaign.id],
      );
    });
  }
}
