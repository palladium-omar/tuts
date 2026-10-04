import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
import { Pool, type PoolClient } from "pg";
import type { Database, EventBus } from "@palladium/service-kit";
import type { PlatformEvent, RequestContext } from "@palladium/contracts";
import { PaymentsService } from "../src/payments.js";
test(
  "PostgreSQL snapshot-owned checkout, duplicate confirmation, encrypted credentials and forced RLS",
  { skip: !process.env.PAYMENTS_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
        connectionString: process.env.PAYMENTS_TEST_DATABASE_URL,
      }),
      tx = await pool.connect();
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      ALLOW_SANDBOX_PAYMENTS: process.env.ALLOW_SANDBOX_PAYMENTS,
      PAYMENT_ENCRYPTION_KEY: process.env.PAYMENT_ENCRYPTION_KEY,
    };
    process.env.NODE_ENV = "test";
    process.env.ALLOW_SANDBOX_PAYMENTS = "true";
    process.env.PAYMENT_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
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
      const service = new PaymentsService(
        { withTenant: tenant } as unknown as Database,
        bus,
      );
      service.onModuleInit();
      const ctx: RequestContext = {
          sub: randomUUID(),
          businessId: randomUUID(),
          role: "owner",
          entitlements: ["payments"],
          requestId: randomUUID(),
        },
        other = { ...ctx, businessId: randomUUID() };
      const merchant = await service.createConnection(
        ctx,
        {
          provider: "sandbox",
          displayName: "Synthetic merchant",
          credentials: { token: "synthetic-token" },
        },
        "connection",
      );
      assert.equal(JSON.stringify(merchant).includes("synthetic-token"), false);
      const invoiceId = randomUUID(),
        input = { invoiceId, connectionId: merchant.id };
      await assert.rejects(
        () => service.create(ctx, input, "checkout"),
        /invoice_snapshot_unavailable/,
      );
      const event = (amountMinor = 100): PlatformEvent => ({
        id: randomUUID(),
        type: "billing.invoice-issued.v1",
        version: 1,
        producer: "billing",
        businessId: ctx.businessId,
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        data: { invoiceId, amountMinor, currency: "USD" },
      });
      const deliver = (value: PlatformEvent) =>
        tenant(ctx.businessId, (conn) =>
          handlers.get(value.type)!(value, conn),
        );
      await deliver(event());
      await deliver(event());
      await assert.rejects(
        () => deliver(event(101)),
        /issued_invoice_snapshot_conflict/,
      );
      const pending = await service.create(ctx, input, "checkout");
      assert.equal(pending.amountMinor, 100);
      assert.equal(pending.status, "pending");
      assert.deepEqual(
        normalized(await service.create(ctx, input, "checkout")),
        normalized(pending),
      );
      assert.equal(
        (await service.create(ctx, input, "second-checkout")).id,
        pending.id,
      );
      await assert.rejects(
        () => service.get(other, pending.id),
        /checkout_not_found/,
      );
      await tenant(other.businessId, async (conn) =>
        assert.equal(
          (
            await conn.query("SELECT id FROM payment_attempts WHERE id=$1", [
              pending.id,
            ])
          ).rowCount,
          0,
        ),
      );
      const confirmed = await service.confirmSandbox(
        ctx,
        pending.id,
        "confirm",
      );
      assert.equal(confirmed.status, "confirmed");
      assert.equal(confirmed.simulated, true);
      assert.deepEqual(
        normalized(await service.confirmSandbox(ctx, pending.id, "confirm")),
        normalized(confirmed),
      );
      assert.deepEqual(
        normalized(
          await service.confirmSandbox(ctx, pending.id, "new-confirm-key"),
        ),
        normalized(confirmed),
      );
      await tenant(ctx.businessId, async (conn) => {
        assert.equal(
          (
            await conn.query(
              "SELECT * FROM provider_events WHERE business_id=$1",
              [ctx.businessId],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await conn.query(
              "SELECT * FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='payments.payment-confirmed.v1'",
              [ctx.businessId],
            )
          ).rowCount,
          1,
        );
        const secret = (
          await conn.query(
            "SELECT credentials_ciphertext FROM payment_connections WHERE id=$1",
            [merchant.id],
          )
        ).rows[0].credentials_ciphertext;
        assert.equal(secret.includes("synthetic-token"), false);
        assert.equal(
          Number(
            (
              await conn.query(
                "SELECT confirmed_minor FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2",
                [ctx.businessId, invoiceId],
              )
            ).rows[0].confirmed_minor,
          ),
          100,
        );
      });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
      await pool.end();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
