import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  BadGatewayException,
} from "@nestjs/common";
import { Database, emitEvent, parseBody } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptCredentials, encryptCredentials } from "./providers.js";
import { idempotent } from "./idempotency.js";
import {
  checkoutPayload,
  requireStripeTest,
  StripeClient,
  stripeCredentialsSchema,
  StripeError,
  validateStripeSession,
  type StripeSession,
} from "./stripe-provider.js";
const uuid = z.string().uuid();
export function requirePaymentManager(ctx: RequestContext) {
  if (!["owner", "admin"].includes(ctx.role))
    throw new ForbiddenException("payment_owner_or_admin_required");
}
export function paymentView(row: Record<string, any>) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    connectionId: row.connection_id,
    provider: row.provider,
    providerReference: row.provider_reference,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    simulated: row.simulated,
    mode: row.provider === "stripe" ? "test" : "sandbox",
    checkoutUrl: row.checkout_url ?? null,
    creationStatus:
      row.creation_status === "creating" &&
      row.stripe_created_at &&
      (!row.stripe_lease_until ||
        new Date(row.stripe_lease_until).getTime() <= Date.now())
        ? "unknown"
        : (row.creation_status ?? "ready"),
    lastError:
      row.last_error ??
      (row.creation_status === "creating" &&
      row.stripe_created_at &&
      (!row.stripe_lease_until ||
        new Date(row.stripe_lease_until).getTime() <= Date.now())
        ? "stripe_creation_interrupted_retry_same_checkout"
        : null),
    expiresAt: row.expires_at ?? null,
    lastRefreshedAt: row.last_refreshed_at ?? null,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}
function expected(row: Record<string, any>) {
  return {
    businessId: row.business_id,
    attemptId: row.id,
    invoiceId: row.invoice_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    generation: row.current_generation,
  };
}
@Injectable()
export class StripeCheckoutsService {
  constructor(
    @Inject(Database)
    private readonly db: Database,
    @Inject(StripeClient)
    private readonly stripe: StripeClient,
  ) {}
  async createConnection(
    ctx: RequestContext,
    input: {
      displayName: string;
      credentials?: Record<string, string>;
    },
    key: unknown,
  ) {
    requirePaymentManager(ctx);
    requireStripeTest();
    const credentials = parseBody(
      stripeCredentialsSchema,
      input.credentials ?? {},
    );
    return this.db.withTenant(ctx.businessId, (tx) =>
      idempotent(
        tx,
        ctx.businessId,
        "connection.create",
        key,
        { provider: "stripe", ...input },
        async () => {
          const row = (
            await tx.query(
              "INSERT INTO payment_connections(id,business_id,provider,display_name,status,credentials_ciphertext,config) VALUES($1,$2,'stripe',$3,'enabled',$4,$5) RETURNING *",
              [
                randomUUID(),
                ctx.businessId,
                input.displayName,
                encryptCredentials(credentials, ctx.businessId),
                JSON.stringify({ verificationStatus: "not_verified" }),
              ],
            )
          ).rows[0];
          await emitEvent(tx, {
            type: "payments.connection-created.v1",
            producer: "payments",
            businessId: ctx.businessId,
            correlationId: ctx.requestId,
            data: { connectionId: row.id, provider: "stripe", simulated: true },
          });
          return {
            id: row.id,
            provider: row.provider,
            displayName: row.display_name,
            status: row.status,
            mode: "test",
            config: row.config,
            simulated: true,
            verifiedAt: null,
            createdAt: row.created_at,
          };
        },
      ),
    );
  }
  async verifyConnection(ctx: RequestContext, id: string) {
    requirePaymentManager(ctx);
    requireStripeTest();
    parseBody(uuid, id);
    const connection = await this.db.withTenant(
      ctx.businessId,
      async (tx) =>
        (
          await tx.query(
            "SELECT * FROM payment_connections WHERE business_id=$1 AND id=$2",
            [ctx.businessId, id],
          )
        ).rows[0],
    );
    if (!connection) throw new NotFoundException("connection_not_found");
    if (connection.provider !== "stripe" || connection.status !== "enabled")
      throw new ConflictException("stripe_connection_unavailable");
    try {
      const credentials = parseBody(
        stripeCredentialsSchema,
        decryptCredentials(connection.credentials_ciphertext, ctx.businessId),
      );
      const raw = await this.stripe.request(
        "GET",
        "/v1/account",
        credentials.secretKey,
      );
      const account = z
        .object({ id: z.string().regex(/^acct_[A-Za-z0-9]+$/) })
        .safeParse(raw);
      if (!account.success)
        throw new StripeError("stripe_account_response_invalid");
      return this.db.withTenant(ctx.businessId, async (tx) => {
        const row = (
          await tx.query(
            "UPDATE payment_connections SET config=$3,verified_at=now() WHERE business_id=$1 AND id=$2 AND status='enabled' RETURNING *",
            [
              ctx.businessId,
              id,
              JSON.stringify({
                accountId: account.data.id,
                verificationStatus: "verified",
              }),
            ],
          )
        ).rows[0];
        if (!row) throw new ConflictException("stripe_connection_unavailable");
        await emitEvent(tx, {
          type: "payments.connection-verified.v1",
          producer: "payments",
          businessId: ctx.businessId,
          correlationId: ctx.requestId,
          data: {
            connectionId: id,
            accountId: account.data.id,
            provider: "stripe",
            simulated: true,
          },
        });
        return {
          id: row.id,
          provider: row.provider,
          displayName: row.display_name,
          status: row.status,
          mode: "test",
          config: row.config,
          simulated: true,
          verifiedAt: row.verified_at,
          createdAt: row.created_at,
        };
      });
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw new BadGatewayException(
        e instanceof StripeError
          ? e.safeMessage
          : "stripe_account_verification_failed",
      );
    }
  }
  async create(
    ctx: RequestContext,
    input: {
      invoiceId: string;
      connectionId: string;
    },
    key: unknown,
  ) {
    requirePaymentManager(ctx);
    requireStripeTest();
    const prepared = await this.db.withTenant(ctx.businessId, (tx) =>
      idempotent(
        tx,
        ctx.businessId,
        "checkout.create",
        key,
        input,
        async () => {
          const invoice = (
            await tx.query(
              "SELECT * FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
              [ctx.businessId, input.invoiceId],
            )
          ).rows[0];
          if (!invoice)
            throw new ConflictException("invoice_snapshot_unavailable");
          const conn = (
            await tx.query(
              "SELECT * FROM payment_connections WHERE business_id=$1 AND id=$2 FOR SHARE",
              [ctx.businessId, input.connectionId],
            )
          ).rows[0];
          if (!conn) throw new NotFoundException("connection_not_found");
          if (conn.provider !== "stripe" || conn.status !== "enabled")
            throw new ConflictException("stripe_connection_unavailable");
          parseBody(
            stripeCredentialsSchema,
            decryptCredentials(conn.credentials_ciphertext, ctx.businessId),
          );
          const prior = (
            await tx.query(
              "SELECT * FROM payment_attempts WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
              [ctx.businessId, input.invoiceId],
            )
          ).rows[0];
          if (prior) {
            if (
              prior.connection_id !== input.connectionId ||
              prior.provider !== "stripe"
            )
              throw new ConflictException({
                message: "invoice_checkout_connection_mismatch",
                checkoutId: prior.id,
              });
            return { id: prior.id };
          }
          if (BigInt(invoice.confirmed_minor) > 0n)
            throw new ConflictException("invoice_already_or_partially_paid");
          const id = randomUUID(),
            payload = Object.fromEntries(
              checkoutPayload({
                businessId: ctx.businessId,
                attemptId: id,
                invoiceId: input.invoiceId,
                amountMinor: Number(invoice.amount_minor),
                currency: invoice.currency,
                generation: 1,
              }),
            );
          await tx.query(
            "INSERT INTO payment_attempts(id,business_id,invoice_id,connection_id,provider,amount_minor,currency,status,provider_reference,simulated,creation_status) VALUES($1,$2,$3,$4,'stripe',$5,$6,'pending',$7,true,'creating')",
            [
              id,
              ctx.businessId,
              input.invoiceId,
              input.connectionId,
              invoice.amount_minor,
              invoice.currency,
              `stripe:${id}:1`,
            ],
          );
          await tx.query(
            "INSERT INTO stripe_checkout_sessions(business_id,attempt_id,generation,payload,status) VALUES($1,$2,1,$3,'creating')",
            [ctx.businessId, id, JSON.stringify(payload)],
          );
          await emitEvent(tx, {
            type: "payments.checkout-created.v1",
            producer: "payments",
            businessId: ctx.businessId,
            correlationId: ctx.requestId,
            data: {
              paymentId: id,
              invoiceId: input.invoiceId,
              provider: "stripe",
              simulated: true,
            },
          });
          return { id };
        },
      ),
    );
    return this.createProviderSession(ctx, prepared.id);
  }
  private async getAttempt(ctx: RequestContext, id: string) {
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query(
          "SELECT a.*,s.lease_until AS stripe_lease_until,s.created_at AS stripe_created_at FROM payment_attempts a LEFT JOIN stripe_checkout_sessions s ON s.business_id=a.business_id AND s.attempt_id=a.id AND s.generation=a.current_generation WHERE a.business_id=$1 AND a.id=$2",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("checkout_not_found");
      return row;
    });
  }
  private async createProviderSession(ctx: RequestContext, id: string) {
    const lease = await this.db.withTenant(ctx.businessId, async (tx) => {
      const attempt = (
        await tx.query(
          "SELECT * FROM payment_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!attempt) throw new NotFoundException("checkout_not_found");
      if (
        attempt.status === "confirmed" ||
        ["ready", "failed", "expired"].includes(attempt.creation_status)
      )
        return null;
      const session = (
        await tx.query(
          "SELECT * FROM stripe_checkout_sessions WHERE business_id=$1 AND attempt_id=$2 AND generation=$3 FOR UPDATE",
          [ctx.businessId, id, attempt.current_generation],
        )
      ).rows[0];
      if (!session)
        throw new ConflictException("stripe_session_record_missing");
      if (
        session.lease_until &&
        new Date(session.lease_until).getTime() > Date.now()
      )
        return null;
      // Stripe may prune provider idempotency records at 24h. Never risk recreating an unresolved checkout after that window.
      if (
        Date.now() - new Date(session.created_at).getTime() >=
        23 * 60 * 60 * 1000
      ) {
        await tx.query(
          "UPDATE payment_attempts SET creation_status='unknown',last_error='stripe_idempotency_window_expired_manual_reconciliation_required' WHERE business_id=$1 AND id=$2",
          [ctx.businessId, id],
        );
        return null;
      }
      const connection = (
        await tx.query(
          "SELECT * FROM payment_connections WHERE business_id=$1 AND id=$2 FOR SHARE",
          [ctx.businessId, attempt.connection_id],
        )
      ).rows[0];
      if (
        !connection ||
        connection.status !== "enabled" ||
        connection.provider !== "stripe"
      )
        throw new ConflictException("stripe_connection_unavailable");
      const credentials = parseBody(
          stripeCredentialsSchema,
          decryptCredentials(connection.credentials_ciphertext, ctx.businessId),
        ),
        token = randomUUID();
      await tx.query(
        "UPDATE stripe_checkout_sessions SET status='creating',lease_token=$4,lease_until=now()+interval '60 seconds',updated_at=now() WHERE business_id=$1 AND attempt_id=$2 AND generation=$3",
        [ctx.businessId, id, attempt.current_generation, token],
      );
      await tx.query(
        "UPDATE payment_attempts SET creation_status='creating',last_error=NULL WHERE business_id=$1 AND id=$2",
        [ctx.businessId, id],
      );
      return { attempt, session, credentials, token };
    });
    if (!lease) return paymentView(await this.getAttempt(ctx, id));
    let verified: StripeSession | undefined, error: StripeError | undefined;
    try {
      const raw = await this.stripe.request(
        "POST",
        "/v1/checkout/sessions",
        lease.credentials.secretKey,
        new URLSearchParams(lease.session.payload),
        `tuts-checkout-${id}-${lease.attempt.current_generation}`,
      );
      verified = validateStripeSession(raw, expected(lease.attempt));
    } catch (e) {
      error =
        e instanceof StripeError
          ? e
          : new StripeError("stripe_checkout_acceptance_unknown", true);
    }
    const result = await this.db.withTenant(ctx.businessId, async (tx) => {
      await tx.query(
        "SELECT invoice_id FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
        [ctx.businessId, lease.attempt.invoice_id],
      );
      const attempt = (
        await tx.query(
          "SELECT * FROM payment_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      const session = (
        await tx.query(
          "SELECT * FROM stripe_checkout_sessions WHERE business_id=$1 AND attempt_id=$2 AND generation=$3 FOR UPDATE",
          [ctx.businessId, id, lease.attempt.current_generation],
        )
      ).rows[0];
      if (
        !attempt ||
        !session ||
        session.lease_token !== lease.token ||
        attempt.current_generation !== lease.attempt.current_generation
      )
        return attempt;
      if (error) {
        const state = error.unknown ? "unknown" : "failed";
        await tx.query(
          "UPDATE stripe_checkout_sessions SET status=$4,last_error=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=$1 AND attempt_id=$2 AND generation=$3",
          [
            ctx.businessId,
            id,
            attempt.current_generation,
            state,
            error.safeMessage,
          ],
        );
        return (
          await tx.query(
            "UPDATE payment_attempts SET creation_status=$3,last_error=$4 WHERE business_id=$1 AND id=$2 RETURNING *",
            [ctx.businessId, id, state, error.safeMessage],
          )
        ).rows[0];
      }
      await tx.query(
        "UPDATE stripe_checkout_sessions SET status=$4,provider_reference=$5,last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=$1 AND attempt_id=$2 AND generation=$3",
        [
          ctx.businessId,
          id,
          attempt.current_generation,
          verified!.status === "expired" ? "expired" : "ready",
          verified!.id,
        ],
      );
      return this.applySession(ctx, tx, attempt, verified!);
    });
    return paymentView(result);
  }
  private async applySession(
    ctx: RequestContext,
    tx: PoolClient,
    attempt: Record<string, any>,
    session: StripeSession,
  ) {
    let changed = (
      await tx.query(
        "UPDATE payment_attempts SET provider_reference=$3,checkout_url=$4,creation_status=$5,expires_at=to_timestamp($6),last_refreshed_at=now(),last_error=NULL WHERE business_id=$1 AND id=$2 RETURNING *",
        [
          ctx.businessId,
          attempt.id,
          session.id,
          session.status === "open" ? session.url : null,
          session.status === "expired" ? "expired" : "ready",
          session.expires_at,
        ],
      )
    ).rows[0];
    if (session.payment_status !== "paid" || attempt.status === "confirmed")
      return changed;
    const invoice = (
      await tx.query(
        "SELECT * FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
        [ctx.businessId, attempt.invoice_id],
      )
    ).rows[0];
    if (!invoice) throw new ConflictException("invoice_snapshot_unavailable");
    if (
      invoice.currency !== attempt.currency ||
      BigInt(invoice.amount_minor) !== BigInt(attempt.amount_minor)
    )
      throw new ConflictException("payment_invoice_mismatch");
    if (
      BigInt(invoice.confirmed_minor) + BigInt(attempt.amount_minor) >
      BigInt(invoice.amount_minor)
    )
      throw new ConflictException("payment_exceeds_amount_due");
    await tx.query(
      "INSERT INTO provider_events(business_id,connection_id,event_reference,attempt_id,event_type,simulated) VALUES($1,$2,$3,$4,'stripe.checkout-session-paid',true) ON CONFLICT DO NOTHING",
      [
        ctx.businessId,
        attempt.connection_id,
        `stripe.session-paid:${session.id}`,
        attempt.id,
      ],
    );
    changed = (
      await tx.query(
        "UPDATE payment_attempts SET status='confirmed',confirmed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
        [ctx.businessId, attempt.id],
      )
    ).rows[0];
    await tx.query(
      "UPDATE invoice_snapshots SET confirmed_minor=confirmed_minor+$3 WHERE business_id=$1 AND invoice_id=$2",
      [ctx.businessId, attempt.invoice_id, attempt.amount_minor],
    );
    await emitEvent(tx, {
      type: "payments.payment-confirmed.v1",
      producer: "payments",
      businessId: ctx.businessId,
      correlationId: ctx.requestId,
      data: {
        paymentId: attempt.id,
        invoiceId: attempt.invoice_id,
        amountMinor: Number(attempt.amount_minor),
        currency: attempt.currency,
        provider: "stripe",
        simulated: true,
      },
    });
    return changed;
  }
  async refresh(ctx: RequestContext, id: string) {
    requirePaymentManager(ctx);
    requireStripeTest();
    parseBody(uuid, id);
    const attempt = await this.getAttempt(ctx, id);
    if (attempt.provider !== "stripe")
      throw new UnprocessableEntityException("checkout_is_not_stripe");
    if (attempt.status === "confirmed") return paymentView(attempt);
    if (!/^cs_test_[A-Za-z0-9]+$/.test(attempt.provider_reference))
      throw new ConflictException(
        "stripe_session_unknown_retry_same_checkout_creation",
      );
    const conn = await this.db.withTenant(
      ctx.businessId,
      async (tx) =>
        (
          await tx.query(
            "SELECT * FROM payment_connections WHERE business_id=$1 AND id=$2",
            [ctx.businessId, attempt.connection_id],
          )
        ).rows[0],
    );
    if (!conn || conn.status !== "enabled" || conn.provider !== "stripe")
      throw new ConflictException("stripe_connection_unavailable");
    let verified: StripeSession;
    try {
      const credentials = parseBody(
        stripeCredentialsSchema,
        decryptCredentials(conn.credentials_ciphertext, ctx.businessId),
      );
      verified = validateStripeSession(
        await this.stripe.request(
          "GET",
          `/v1/checkout/sessions/${attempt.provider_reference}`,
          credentials.secretKey,
        ),
        expected(attempt),
        attempt.provider_reference,
      );
    } catch (e) {
      throw new BadGatewayException(
        e instanceof StripeError ? e.safeMessage : "stripe_refresh_failed",
      );
    }
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await tx.query(
        "SELECT invoice_id FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
        [ctx.businessId, attempt.invoice_id],
      );
      const current = (
        await tx.query(
          "SELECT * FROM payment_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!current) throw new NotFoundException("checkout_not_found");
      if (current.status === "confirmed") return paymentView(current);
      if (
        current.provider_reference !== verified.id ||
        current.current_generation !== attempt.current_generation
      )
        throw new ConflictException("stripe_checkout_changed_refresh_again");
      await tx.query(
        "UPDATE stripe_checkout_sessions SET status=$4,updated_at=now() WHERE business_id=$1 AND attempt_id=$2 AND generation=$3",
        [
          ctx.businessId,
          id,
          current.current_generation,
          verified.status === "expired" ? "expired" : "ready",
        ],
      );
      return paymentView(await this.applySession(ctx, tx, current, verified));
    });
  }
}
