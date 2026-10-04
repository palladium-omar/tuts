import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  CurrentContext,
  Database,
  EventBus,
  Roles,
  emitEvent,
  parseBody,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import { z } from "zod";
import { ApiTags, ApiBody, ApiHeader, ApiOperation } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import {
  adapter,
  catalogue,
  encryptCredentials,
  decryptCredentials,
  providers,
  requireSandbox,
  nextPaymentStatus,
} from "./providers.js";
import {
  StripeCheckoutsService,
  paymentView,
  requirePaymentManager,
} from "./stripe-checkouts.js";
import { StripeClient } from "./stripe-provider.js";
import { idempotent } from "./idempotency.js";
const idSchema = z.string().uuid();
const snapshotSchema = z.object({
  invoiceId: idSchema,
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const connectionSchema = z
  .object({
    provider: z.enum(providers),
    displayName: z.string().trim().min(1).max(200),
    credentials: z.record(z.string().max(100), z.string().max(5000)).optional(),
  })
  .strict();
const checkoutSchema = z
  .object({ invoiceId: idSchema, connectionId: idSchema })
  .strict();
const checkout = paymentView;
function connection(row: Record<string, any>) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    status: row.status,
    capabilities: catalogue().find((entry) => entry.provider === row.provider)
      ?.capabilities,
    mode: row.provider === "stripe" ? "test" : "sandbox",
    config: row.config ?? {},
    verifiedAt: row.verified_at ?? null,
    simulated: row.provider === "sandbox" || row.provider === "stripe",
    createdAt: row.created_at,
  };
}
@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    @Inject(Database)
    private readonly db: Database,
    @Inject(EventBus)
    private readonly bus: EventBus,
    @Inject(StripeCheckoutsService)
    private readonly stripe: StripeCheckoutsService = new StripeCheckoutsService(
      db,
      new StripeClient(),
    ),
  ) {}
  onModuleInit() {
    this.bus.subscribe("billing.invoice-issued.v1", async (event, tx) => {
      if (event.producer !== "billing")
        throw new Error("invoice_producer_invalid");
      const value = parseBody(snapshotSchema, event.data);
      await tx.query(
        "INSERT INTO invoice_snapshots (business_id,invoice_id,amount_minor,currency,issued_event_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          event.businessId,
          value.invoiceId,
          value.amountMinor,
          value.currency,
          event.id,
        ],
      );
      const { rows } = await tx.query(
        "SELECT amount_minor,currency FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
        [event.businessId, value.invoiceId],
      );
      if (
        !rows[0] ||
        Number(rows[0].amount_minor) !== value.amountMinor ||
        rows[0].currency !== value.currency
      )
        throw new Error("issued_invoice_snapshot_conflict");
    });
  }
  providers() {
    return catalogue();
  }
  connections(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) =>
      (
        await tx.query(
          "SELECT * FROM payment_connections WHERE business_id=$1 ORDER BY created_at DESC LIMIT 200",
          [ctx.businessId],
        )
      ).rows.map(connection),
    );
  }
  createConnection(ctx: RequestContext, body: unknown, key: unknown) {
    requirePaymentManager(ctx);
    const input = parseBody(connectionSchema, body);
    if (input.provider === "stripe")
      return this.stripe.createConnection(ctx, input, key);
    if (input.provider !== "sandbox")
      throw new UnprocessableEntityException(
        `${input.provider}_integration_unavailable`,
      );
    requireSandbox();
    const credentials = input.credentials ?? {};
    if (Object.keys(credentials).length > 20)
      throw new UnprocessableEntityException("too_many_credential_fields");
    return this.db.withTenant(ctx.businessId, (tx) =>
      idempotent(
        tx,
        ctx.businessId,
        "connection.create",
        key,
        input,
        async () => {
          const encrypted = encryptCredentials(credentials, ctx.businessId);
          const { rows } = await tx.query(
            "INSERT INTO payment_connections (id,business_id,provider,display_name,status,credentials_ciphertext) VALUES ($1,$2,$3,$4,'enabled',$5) RETURNING id,provider,display_name,status,created_at",
            [
              randomUUID(),
              ctx.businessId,
              input.provider,
              input.displayName,
              encrypted,
            ],
          );
          return connection(rows[0]);
        },
      ),
    );
  }
  list(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) =>
      (
        await tx.query(
          "SELECT a.*,s.lease_until AS stripe_lease_until,s.created_at AS stripe_created_at FROM payment_attempts a LEFT JOIN stripe_checkout_sessions s ON s.business_id=a.business_id AND s.attempt_id=a.id AND s.generation=a.current_generation WHERE a.business_id=$1 ORDER BY a.created_at DESC LIMIT 200",
          [ctx.businessId],
        )
      ).rows.map(checkout),
    );
  }
  get(ctx: RequestContext, id: string) {
    parseBody(idSchema, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const { rows } = await tx.query(
        "SELECT a.*,s.lease_until AS stripe_lease_until,s.created_at AS stripe_created_at FROM payment_attempts a LEFT JOIN stripe_checkout_sessions s ON s.business_id=a.business_id AND s.attempt_id=a.id AND s.generation=a.current_generation WHERE a.business_id=$1 AND a.id=$2",
        [ctx.businessId, id],
      );
      if (!rows[0]) throw new NotFoundException("checkout_not_found");
      return checkout(rows[0]);
    });
  }
  async create(ctx: RequestContext, body: unknown, key: unknown) {
    requirePaymentManager(ctx);
    const input = parseBody(checkoutSchema, body);
    const merchant = await this.db.withTenant(
      ctx.businessId,
      async (tx) =>
        (
          await tx.query(
            "SELECT provider FROM payment_connections WHERE business_id=$1 AND id=$2",
            [ctx.businessId, input.connectionId],
          )
        ).rows[0],
    );
    if (merchant?.provider === "stripe")
      return this.stripe.create(ctx, input, key);
    return this.db.withTenant(ctx.businessId, (tx) =>
      idempotent(
        tx,
        ctx.businessId,
        "checkout.create",
        key,
        input,
        async () => {
          const invoice = await tx.query(
            "SELECT * FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
            [ctx.businessId, input.invoiceId],
          );
          if (!invoice.rows[0])
            throw new ConflictException("invoice_snapshot_unavailable");
          const merchant = await tx.query(
            "SELECT * FROM payment_connections WHERE business_id=$1 AND id=$2",
            [ctx.businessId, input.connectionId],
          );
          if (!merchant.rows[0])
            throw new NotFoundException("connection_not_found");
          if (merchant.rows[0].status !== "enabled")
            throw new UnprocessableEntityException("connection_unavailable");
          const provider = merchant.rows[0].provider;
          const selected = adapter(provider);
          const prior = await tx.query(
            "SELECT * FROM payment_attempts WHERE business_id=$1 AND invoice_id=$2",
            [ctx.businessId, input.invoiceId],
          );
          if (prior.rows[0]) {
            if (prior.rows[0].connection_id !== input.connectionId)
              throw new ConflictException({
                message: "invoice_checkout_connection_mismatch",
                checkoutId: prior.rows[0].id,
              });
            return checkout(prior.rows[0]);
          }
          if (Number(invoice.rows[0].confirmed_minor) > 0)
            throw new ConflictException("invoice_already_paid");
          const id = randomUUID(),
            reference = `sandbox:${id}`;
          // Sandbox performs no network call. The attempt still exists before adapter checkout creation.
          const { rows } = await tx.query(
            "INSERT INTO payment_attempts (id,business_id,invoice_id,connection_id,provider,amount_minor,currency,status,provider_reference,simulated) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,true) RETURNING *",
            [
              id,
              ctx.businessId,
              input.invoiceId,
              input.connectionId,
              provider,
              invoice.rows[0].amount_minor,
              invoice.rows[0].currency,
              reference,
            ],
          );
          selected.createCheckout(
            {
              id: merchant.rows[0].id,
              businessId: ctx.businessId,
              provider,
              credentials: decryptCredentials(
                merchant.rows[0].credentials_ciphertext,
                ctx.businessId,
              ),
            },
            {
              id,
              businessId: ctx.businessId,
              connectionId: input.connectionId,
              provider,
              status: "pending",
              amountMinor: Number(rows[0].amount_minor),
              currency: rows[0].currency,
              providerReference: reference,
            },
          );
          return checkout(rows[0]);
        },
      ),
    );
  }
  verifyConnection(ctx: RequestContext, id: string) {
    return this.stripe.verifyConnection(ctx, id);
  }
  refresh(ctx: RequestContext, id: string) {
    return this.stripe.refresh(ctx, id);
  }
  disableConnection(ctx: RequestContext, id: string) {
    requirePaymentManager(ctx);
    parseBody(idSchema, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query(
          "UPDATE payment_connections SET status='disabled' WHERE business_id=$1 AND id=$2 RETURNING *",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("connection_not_found");
      await emitEvent(tx, {
        type: "payments.connection-disabled.v1",
        producer: "payments",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { connectionId: id },
      });
      return connection(row);
    });
  }
  confirmSandbox(ctx: RequestContext, id: string, key: unknown) {
    parseBody(idSchema, id);
    requireSandbox();
    return this.db.withTenant(ctx.businessId, (tx) =>
      idempotent(
        tx,
        ctx.businessId,
        "checkout.sandbox-confirm",
        key,
        { checkoutId: id },
        async () => {
          const { rows } = await tx.query(
            "SELECT * FROM payment_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE",
            [ctx.businessId, id],
          );
          const attempt = rows[0];
          if (!attempt) throw new NotFoundException("checkout_not_found");
          if (attempt.provider !== "sandbox" || attempt.simulated !== true)
            throw new UnprocessableEntityException("checkout_is_not_sandbox");
          if (attempt.status === "confirmed") return checkout(attempt);
          const merchant = await tx.query(
            "SELECT provider,status FROM payment_connections WHERE business_id=$1 AND id=$2",
            [ctx.businessId, attempt.connection_id],
          );
          if (
            !merchant.rows[0] ||
            merchant.rows[0].provider !== "sandbox" ||
            merchant.rows[0].status !== "enabled"
          )
            throw new ConflictException("sandbox_connection_unavailable");
          const snapshot = await tx.query(
            "SELECT * FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2 FOR UPDATE",
            [ctx.businessId, attempt.invoice_id],
          );
          if (!snapshot.rows[0])
            throw new ConflictException("invoice_snapshot_unavailable");
          if (
            snapshot.rows[0].currency !== attempt.currency ||
            Number(snapshot.rows[0].amount_minor) !==
              Number(attempt.amount_minor)
          )
            throw new ConflictException("payment_invoice_mismatch");
          if (
            BigInt(snapshot.rows[0].confirmed_minor) +
              BigInt(attempt.amount_minor) >
            BigInt(snapshot.rows[0].amount_minor)
          )
            throw new ConflictException("payment_exceeds_amount_due");
          const ref = `sandbox.confirmed:${id}`;
          await tx.query(
            "INSERT INTO provider_events (business_id,connection_id,event_reference,attempt_id,event_type,simulated) VALUES ($1,$2,$3,$4,$5,true)",
            [
              ctx.businessId,
              attempt.connection_id,
              ref,
              id,
              "sandbox.confirmed",
            ],
          );
          const next = nextPaymentStatus(attempt.status, "confirmed");
          const changed = await tx.query(
            "UPDATE payment_attempts SET status=$3,confirmed_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
            [ctx.businessId, id, next],
          );
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
              paymentId: id,
              invoiceId: attempt.invoice_id,
              amountMinor: Number(attempt.amount_minor),
              currency: attempt.currency,
              provider: "sandbox",
              simulated: true,
            },
          });
          return checkout(changed.rows[0]);
        },
      ),
    );
  }
}
@ApiTags("Payments")
@Controller("v1")
@Roles("owner", "admin", "tutor")
export class PaymentsController {
  constructor(
    @Inject(PaymentsService)
    private readonly service: PaymentsService,
  ) {}
  @Get("providers")
  providers() {
    return { items: this.service.providers() };
  }
  @Get("connections")
  async connections(
    @CurrentContext()
    ctx: RequestContext,
  ) {
    return { items: await this.service.connections(ctx) };
  }
  @Post("connections")
  @Roles("owner", "admin")
  @ApiOperation({
    summary: "Connect a sandbox or existing Stripe test account (owner/admin)",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "displayName"],
      properties: {
        provider: {
          type: "string",
          enum: ["sandbox", "stripe", "paypal", "bank"],
          description:
            "Sandbox and Stripe test mode are implemented; other providers return 422.",
        },
        displayName: { type: "string", maxLength: 200 },
        credentials: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Stripe needs secretKey (sk_test_ or rk_test_). Credentials encrypted at rest and never returned.",
        },
      },
    },
  })
  async createConnection(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
    @Headers("idempotency-key")
    key: string,
  ) {
    return { item: await this.service.createConnection(ctx, body, key) };
  }
  @Post("connections/:id/verify")
  @Roles("owner", "admin")
  async verify(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
  ) {
    return { item: await this.service.verifyConnection(ctx, id) };
  }
  @Delete("connections/:id")
  @Roles("owner", "admin")
  async disable(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
  ) {
    return { item: await this.service.disableConnection(ctx, id) };
  }
  @Post("checkouts/:id/refresh")
  @Roles("owner", "admin")
  async refresh(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
  ) {
    return { item: await this.service.refresh(ctx, id) };
  }
  @Get("checkouts")
  async list(
    @CurrentContext()
    ctx: RequestContext,
  ) {
    return { items: await this.service.list(ctx) };
  }
  @Get("checkouts/:id")
  async get(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
  ) {
    return { item: await this.service.get(ctx, id) };
  }
  @Post("checkouts")
  @Roles("owner", "admin")
  @ApiOperation({
    summary: "Create one checkout using the issued-invoice event snapshot",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["invoiceId", "connectionId"],
      properties: {
        invoiceId: { type: "string", format: "uuid" },
        connectionId: { type: "string", format: "uuid" },
      },
    },
  })
  async create(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
    @Headers("idempotency-key")
    key: string,
  ) {
    return { item: await this.service.create(ctx, body, key) };
  }
  @Post("checkouts/:id/sandbox-confirm")
  @ApiOperation({
    summary: "Simulate a sandbox confirmation (staff, development/test only)",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async confirm(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
    @Headers("idempotency-key")
    key: string,
  ) {
    return { item: await this.service.confirmSandbox(ctx, id, key) };
  }
}
