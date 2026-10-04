import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
import { Pool, type PoolClient } from "pg";
import type { Database, EventBus } from "@palladium/service-kit";
import type { PlatformEvent, RequestContext } from "@palladium/contracts";
import { BillingService } from "../src/billing.js";

test(
  "PostgreSQL financial allocation, tenant isolation, transactional outbox and idempotency",
  { skip: !process.env.BILLING_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.BILLING_TEST_DATABASE_URL,
    });
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const role = await tx.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      assert.equal(role.rows[0].rolsuper, false);
      assert.equal(role.rows[0].rolbypassrls, false);
      async function tenant<T>(
        businessId: string,
        work: (tx: PoolClient) => Promise<T>,
      ) {
        await tx.query("SAVEPOINT test_operation");
        try {
          await tx.query("SELECT set_config('app.business_id',$1,true)", [
            businessId,
          ]);
          const result = await work(tx);
          await tx.query("RELEASE SAVEPOINT test_operation");
          return result;
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT test_operation");
          await tx.query("RELEASE SAVEPOINT test_operation");
          throw error;
        }
      }
      const handlers = new Map<
        string,
        (event: PlatformEvent, tx: PoolClient) => Promise<void>
      >();
      const bus = {
        subscribe: (
          type: string,
          handler: (event: PlatformEvent, tx: PoolClient) => Promise<void>,
        ) => handlers.set(type, handler),
      } as unknown as EventBus;
      const service = new BillingService(
        { withTenant: tenant } as unknown as Database,
        bus,
      );
      service.onModuleInit();
      const ctx: RequestContext = {
        sub: randomUUID(),
        businessId: randomUUID(),
        role: "owner",
        entitlements: ["billing"],
        requestId: randomUUID(),
      };
      const other = { ...ctx, businessId: randomUUID() };
      const input = {
        payerName: "Synthetic payer",
        currency: "USD",
        items: [{ description: "Lesson", quantity: 2, unitPriceMinor: 50 }],
      };
      const draft = await service.create(ctx, input, "create");
      assert.equal(draft.totalMinor, 100);
      assert.deepEqual(
        normalized(await service.create(ctx, input, "create")),
        normalized(draft),
      );
      await assert.rejects(
        () => service.create(ctx, { ...input, payerName: "Changed" }, "create"),
        /idempotency_key_payload_mismatch/,
      );
      await tenant(ctx.businessId, (conn) =>
        conn.query(
          "INSERT INTO business_seller_profiles(business_id,revision,seller) VALUES($1,1,$2::jsonb)",
          [
            ctx.businessId,
            JSON.stringify({
              businessId: ctx.businessId,
              name: "Synthetic seller",
              profile: {},
              branding: {},
            }),
          ],
        ),
      );
      const issued = await service.issue(ctx, draft.id, "issue");
      assert.equal(issued.status, "issued");
      assert.deepEqual(
        normalized(await service.issue(ctx, draft.id, "issue")),
        normalized(issued),
      );
      await assert.rejects(
        () => service.get(other, draft.id),
        /invoice_not_found/,
      );
      await tenant(other.businessId, async (conn) =>
        assert.equal(
          (await conn.query("SELECT id FROM invoices WHERE id=$1", [draft.id]))
            .rowCount,
          0,
        ),
      );
      const paymentId = randomUUID();
      const event = (
        amountMinor: number,
        paymentIdValue = paymentId,
        currency = "USD",
      ): PlatformEvent => ({
        id: randomUUID(),
        type: "payments.payment-confirmed.v1",
        version: 1,
        producer: "payments",
        businessId: ctx.businessId,
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        data: {
          paymentId: paymentIdValue,
          invoiceId: draft.id,
          amountMinor,
          currency,
          provider: "sandbox",
        },
      });
      const deliver = (value: PlatformEvent) =>
        tenant(ctx.businessId, (conn) =>
          handlers.get(value.type)!(value, conn),
        );
      await deliver(event(40));
      await deliver(event(40));
      assert.equal((await service.get(ctx, draft.id)).paidMinor, 40);
      await assert.rejects(
        () => deliver(event(41)),
        /payment_allocation_identity_conflict/,
      );
      await assert.rejects(
        () => deliver(event(60, randomUUID(), "EUR")),
        /payment_currency_mismatch/,
      );
      await assert.rejects(
        () => deliver(event(61, randomUUID())),
        /payment_exceeds_amount_due/,
      );
      await deliver(event(60, randomUUID()));
      assert.equal((await service.get(ctx, draft.id)).status, "settled");
      await tenant(ctx.businessId, async (conn) => {
        assert.equal(
          (
            await conn.query(
              "SELECT * FROM payment_allocations WHERE business_id=$1",
              [ctx.businessId],
            )
          ).rowCount,
          2,
        );
        assert.equal(
          (
            await conn.query(
              "SELECT * FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='billing.invoice-issued.v1'",
              [ctx.businessId],
            )
          ).rowCount,
          1,
        );
      });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
      await pool.end();
    }
  },
);
