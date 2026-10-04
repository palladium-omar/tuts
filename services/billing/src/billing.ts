import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  ConflictException,
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
  allocatePayment,
  invoiceSchema,
  paymentSchema,
  totalMinor,
  serviceMonthView,
} from "./financial.js";
import { sellerEventSchema } from "./seller.js";
import { idempotent } from "./idempotency.js";
const idSchema = z.string().uuid();
export function invoice(row: Record<string, any>) {
  return {
    id: row.id,
    clientId: row.client_id,
    payerName: row.payer_name,
    currency: row.currency,
    items: row.items,
    totalMinor: Number(row.total_minor),
    paidMinor: Number(row.paid_minor),
    status: row.status,
    createdAt: row.created_at,
    issuedAt: row.issued_at,
    sellerSnapshot: row.seller_snapshot ?? null,
    serviceMonth: serviceMonthView(row.service_month),
    dueAt: row.due_at ?? null,
    classIds: row.class_ids ?? [],
  };
}
@Injectable()
export class BillingService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(EventBus) private readonly bus: EventBus,
  ) {}
  onModuleInit() {
    this.bus.subscribe(
      "platform.business-profile-updated.v1",
      async (event, tx) => {
        if (event.producer !== "platform")
          throw new Error("seller_producer_invalid");
        const { revision, ...seller } = parseBody(
          sellerEventSchema,
          event.data,
        );
        if (seller.businessId !== event.businessId)
          throw new Error("seller_business_mismatch");
        await tx.query(
          `INSERT INTO business_seller_profiles (business_id,revision,seller) VALUES ($1,$2,$3)
        ON CONFLICT (business_id) DO UPDATE SET revision=EXCLUDED.revision,seller=EXCLUDED.seller,updated_at=now()
        WHERE business_seller_profiles.revision < EXCLUDED.revision`,
          [event.businessId, revision, seller],
        );
      },
    );
    this.bus.subscribe("payments.payment-confirmed.v1", async (event, tx) => {
      if (event.producer !== "payments")
        throw new Error("payment_producer_invalid");
      const payment = parseBody(paymentSchema, event.data);
      const prior = await tx.query(
        "SELECT * FROM payment_allocations WHERE business_id=$1 AND payment_id=$2",
        [event.businessId, payment.paymentId],
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (
          row.invoice_id !== payment.invoiceId ||
          Number(row.amount_minor) !== payment.amountMinor ||
          row.currency !== payment.currency ||
          row.provider !== payment.provider ||
          (row.simulated ?? row.provider === "sandbox") !==
            (payment.simulated || payment.provider === "sandbox")
        )
          throw new Error("payment_allocation_identity_conflict");
        return;
      }
      const found = await tx.query(
        "SELECT * FROM invoices WHERE business_id=$1 AND id=$2 FOR UPDATE",
        [event.businessId, payment.invoiceId],
      );
      if (!found.rows[0]) throw new Error("payment_invoice_unknown");
      const current = invoice(found.rows[0]);
      // Check payment identity again after acquiring the invoice lock: different broker deliveries may race.
      const lockedPrior = await tx.query(
        "SELECT * FROM payment_allocations WHERE business_id=$1 AND payment_id=$2",
        [event.businessId, payment.paymentId],
      );
      if (lockedPrior.rows[0]) {
        const row = lockedPrior.rows[0];
        if (
          row.invoice_id !== payment.invoiceId ||
          Number(row.amount_minor) !== payment.amountMinor ||
          row.currency !== payment.currency ||
          row.provider !== payment.provider ||
          (row.simulated ?? row.provider === "sandbox") !==
            (payment.simulated || payment.provider === "sandbox")
        )
          throw new Error("payment_allocation_identity_conflict");
        return;
      }
      const next = allocatePayment(current, payment);
      await tx.query(
        "INSERT INTO payment_allocations (business_id,payment_id,invoice_id,amount_minor,currency,provider,simulated) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          event.businessId,
          payment.paymentId,
          payment.invoiceId,
          payment.amountMinor,
          payment.currency,
          payment.provider,
          payment.simulated || payment.provider === "sandbox",
        ],
      );
      await tx.query(
        "UPDATE invoices SET paid_minor=$3,status=$4 WHERE business_id=$1 AND id=$2",
        [event.businessId, payment.invoiceId, next.paidMinor, next.status],
      );
    });
  }
  list(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) =>
      (
        await tx.query(
          "SELECT * FROM invoices WHERE business_id=$1 ORDER BY created_at DESC LIMIT 200",
          [ctx.businessId],
        )
      ).rows.map(invoice),
    );
  }
  get(ctx: RequestContext, id: string) {
    parseBody(idSchema, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const { rows } = await tx.query(
        "SELECT * FROM invoices WHERE business_id=$1 AND id=$2",
        [ctx.businessId, id],
      );
      if (!rows[0]) throw new NotFoundException("invoice_not_found");
      return invoice(rows[0]);
    });
  }
  create(ctx: RequestContext, body: unknown, key: unknown) {
    const input = parseBody(invoiceSchema, body),
      total = totalMinor(input.items);
    return this.db.withTenant(ctx.businessId, (tx) =>
      idempotent(tx, ctx.businessId, "invoice.create", key, input, async () => {
        const projected = await tx.query(
          "SELECT seller FROM business_seller_profiles WHERE business_id=$1",
          [ctx.businessId],
        );
        const { rows } = await tx.query(
          "INSERT INTO invoices (id,business_id,client_id,payer_name,currency,items,total_minor,seller_snapshot) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *",
          [
            randomUUID(),
            ctx.businessId,
            input.clientId ?? null,
            input.payerName,
            input.currency,
            JSON.stringify(input.items),
            total,
            projected.rows[0]?.seller ?? null,
          ],
        );
        return invoice(rows[0]);
      }),
    );
  }
  issue(ctx: RequestContext, id: string, key: unknown) {
    parseBody(idSchema, id);
    return this.db.withTenant(ctx.businessId, (tx) =>
      idempotent(
        tx,
        ctx.businessId,
        "invoice.issue",
        key,
        { invoiceId: id },
        async () => {
          const { rows } = await tx.query(
            "SELECT * FROM invoices WHERE business_id=$1 AND id=$2 FOR UPDATE",
            [ctx.businessId, id],
          );
          if (!rows[0]) throw new NotFoundException("invoice_not_found");
          if (rows[0].status !== "draft")
            throw new ConflictException("invoice_already_issued");
          const projected = await tx.query(
            "SELECT seller FROM business_seller_profiles WHERE business_id=$1",
            [ctx.businessId],
          );
          if (!projected.rows[0])
            throw new ConflictException(
              "Business identity is still syncing. Save business settings, then retry issuing the invoice.",
            );
          const changed = await tx.query(
            "UPDATE invoices SET status='issued',issued_at=now(),seller_snapshot=$3 WHERE business_id=$1 AND id=$2 RETURNING *",
            [ctx.businessId, id, projected.rows[0].seller],
          );
          const result = invoice(changed.rows[0]);
          await emitEvent(tx, {
            type: "billing.invoice-issued.v1",
            producer: "billing",
            businessId: ctx.businessId,
            correlationId: ctx.requestId,
            data: {
              invoiceId: id,
              amountMinor: result.totalMinor,
              currency: result.currency,
            },
          });
          return result;
        },
      ),
    );
  }
}
@ApiTags("Billing")
@Controller("v1/invoices")
@Roles("owner", "admin", "tutor")
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly service: BillingService,
  ) {}
  @Get() async list(@CurrentContext() ctx: RequestContext) {
    return { items: await this.service.list(ctx) };
  }
  @Get(":id") async get(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
  ) {
    return { item: await this.service.get(ctx, id) };
  }
  @Post()
  @ApiOperation({
    summary: "Create a draft invoice with integer minor-unit line prices",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["payerName", "currency", "items"],
      properties: {
        payerName: { type: "string", maxLength: 200 },
        clientId: { type: "string", format: "uuid" },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "quantity", "unitPriceMinor"],
            properties: {
              description: { type: "string", maxLength: 500 },
              quantity: { type: "integer", minimum: 1, maximum: 1000000 },
              unitPriceMinor: {
                type: "integer",
                minimum: 0,
                maximum: 9007199254740991,
              },
            },
          },
        },
      },
    },
  })
  async create(
    @CurrentContext() ctx: RequestContext,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string,
  ) {
    return { item: await this.service.create(ctx, body, key) };
  }
  @Post(":id/issue")
  @ApiOperation({
    summary:
      "Issue a draft invoice and publish its authoritative amount snapshot",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async issue(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
    @Headers("idempotency-key") key: string,
  ) {
    return { item: await this.service.issue(ctx, id, key) };
  }
}
