import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Database, EventBus } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import {
  MonthlyService,
  previousMonth,
  localDate,
  projectClass,
  classSnapshotSchema,
} from "../src/monthly.js";
import { paymentSchema } from "../src/financial.js";
test("previous service month and business-local billing day handle year and timezone boundaries", () => {
  assert.equal(previousMonth("2026-10"), "2026-09");
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.deepEqual(
    localDate(new Date("2026-10-01T00:30:00Z"), "America/New_York"),
    { month: "2026-09", day: 30 },
  );
  assert.deepEqual(localDate(new Date("2026-10-01T00:30:00Z"), "Asia/Tokyo"), {
    month: "2026-10",
    day: 1,
  });
  assert.equal(
    classSnapshotSchema.safeParse({
      classId: randomUUID(),
      source: "external",
      clientId: null,
      startsAt: "2026-09-01T10:00:00Z",
      endsAt: "2026-09-01T09:00:00Z",
      status: "scheduled",
      revision: 1,
    }).success,
    false,
  );
  assert.equal(
    paymentSchema.parse({
      paymentId: randomUUID(),
      invoiceId: randomUUID(),
      amountMinor: 1,
      currency: "USD",
      provider: "stripe",
      simulated: true,
    }).simulated,
    true,
  );
});
test(
  "PostgreSQL monthly drafts count only completed classes, isolate tenants, handle retries/late classes and separate test revenue",
  { skip: !process.env.BILLING_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
        connectionString: process.env.BILLING_TEST_DATABASE_URL,
      }),
      tx = await pool.connect();
    const ctx: RequestContext = {
        businessId: randomUUID(),
        sub: randomUUID(),
        role: "owner",
        entitlements: ["billing"],
        requestId: randomUUID(),
      },
      other = { ...ctx, businessId: randomUUID() };
    const student = randomUUID(),
      unrated = randomUUID();
    const withTenant = async <T>(
      id: string,
      work: (conn: PoolClient) => Promise<T>,
    ) => {
      await tx.query("SAVEPOINT monthly_operation");
      try {
        await tx.query("SELECT set_config('app.business_id',$1,true)", [id]);
        const result = await work(tx);
        await tx.query("RELEASE SAVEPOINT monthly_operation");
        return result;
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT monthly_operation");
        throw error;
      }
    };
    const service = new MonthlyService(
      {
        withTenant,
        pool: {
          query: async () => ({ rows: [{ business_id: ctx.businessId }] }),
        },
      } as unknown as Database,
      { subscribe: () => {} } as unknown as EventBus,
    );
    const classInput = (
      id: string,
      clientId: string | null,
      startsAt: string,
      status: "completed" | "scheduled" | "cancelled" = "completed",
      revision = 1,
    ) => ({
      classId: id,
      clientId,
      source: "external" as const,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(),
      status,
      revision,
      title: "Synthetic class",
    });
    try {
      await tx.query("BEGIN");
      const role = (
        await tx.query(
          "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
      await service.updateSettings(ctx, {
        timeZone: "America/New_York",
        autoDraft: false,
      });
      await service.createRate(ctx, {
        clientId: student,
        payerName: "Synthetic payer",
        currency: "USD",
        unitPriceMinor: 250,
      });
      const first = randomUUID(),
        boundary = randomUUID();
      await withTenant(ctx.businessId, async (conn) => {
        await projectClass(
          conn,
          ctx.businessId,
          classInput(first, student, "2020-09-15T10:00:00Z", "completed", 2),
        );
        await projectClass(
          conn,
          ctx.businessId,
          classInput(first, student, "2020-09-15T10:00:00Z", "scheduled", 1),
        );
        await projectClass(
          conn,
          ctx.businessId,
          classInput(boundary, student, "2020-10-01T00:30:00Z"),
        );
        await projectClass(
          conn,
          ctx.businessId,
          classInput(randomUUID(), student, "2020-10-01T05:00:00Z"),
        );
        await projectClass(
          conn,
          ctx.businessId,
          classInput(
            randomUUID(),
            student,
            "2020-09-16T10:00:00Z",
            "scheduled",
          ),
        );
        await projectClass(
          conn,
          ctx.businessId,
          classInput(
            randomUUID(),
            student,
            "2020-09-17T10:00:00Z",
            "cancelled",
          ),
        );
        await projectClass(
          conn,
          ctx.businessId,
          classInput(randomUUID(), unrated, "2020-09-18T10:00:00Z"),
        );
        await projectClass(
          conn,
          ctx.businessId,
          classInput(randomUUID(), null, "2020-09-19T10:00:00Z"),
        );
      });
      const preview = await service.preview(ctx, { month: "2020-09" });
      assert.equal(preview.students[0].completedCount, 2);
      assert.equal(preview.students[0].totalMinor, 500);
      assert.equal(preview.unrated.length, 1);
      assert.equal(preview.unmatched.length, 1);
      assert.equal(
        (await service.preview(other, { month: "2020-09" })).students.length,
        0,
      );
      const generated = await service.generate(ctx, { month: "2020-09" });
      assert.equal(generated.created.length, 1);
      assert.equal(generated.created[0].items[0].quantity, 2);
      assert.equal(generated.created[0].totalMinor, 500);
      assert.equal(
        new Date(generated.created[0].dueAt).toISOString(),
        "2020-10-01T04:00:00.000Z",
      );
      assert.equal(generated.created[0].status, "draft");
      const retry = await service.generate(ctx, { month: "2020-09" });
      assert.equal(retry.created.length, 0);
      assert.equal(retry.existing[0].id, generated.created[0].id);
      await withTenant(ctx.businessId, (conn) =>
        projectClass(
          conn,
          ctx.businessId,
          classInput(randomUUID(), student, "2020-09-20T10:00:00Z"),
        ),
      );
      const late = await service.generate(ctx, { month: "2020-09" });
      assert.equal(late.created.length, 0);
      assert.equal(late.requiresReview.length, 1);
      await withTenant(ctx.businessId, async (conn) => {
        const invoiceId = generated.created[0].id;
        await conn.query(
          "UPDATE invoices SET status='issued',issued_at='2020-10-02T10:00:00Z' WHERE id=$1",
          [invoiceId],
        );
        await conn.query(
          "INSERT INTO payment_allocations(business_id,payment_id,invoice_id,amount_minor,currency,provider,simulated,created_at) VALUES($1,$2,$3,100,'USD','bank',false,'2020-10-03T10:00:00Z'),($1,$4,$3,150,'USD','stripe',true,'2020-10-03T10:00:00Z')",
          [ctx.businessId, randomUUID(), invoiceId, randomUUID()],
        );
        await conn.query("UPDATE invoices SET paid_minor=250 WHERE id=$1", [
          invoiceId,
        ]);
      });
      const september = await service.dashboard(ctx, { month: "2020-09" });
      assert.equal(
        september.students.find((r) => r.clientId === student)!.completedCount,
        3,
      );
      assert.equal(
        september.students.find((r) => r.clientId === student)!.scheduledCount,
        1,
      );
      assert.equal(
        september.students.find((r) => r.clientId === student)!.cancelledCount,
        1,
      );
      assert.ok(september.students.some((r) => r.clientId === unrated));
      assert.equal(september.currencies[0].billedMinor, 0);
      const october = await service.dashboard(ctx, { month: "2020-10" });
      assert.deepEqual(october.currencies[0], {
        currency: "USD",
        billedMinor: 500,
        collectedMinor: 100,
        sandboxCollectedMinor: 150,
        outstandingMinor: 400,
        allTimeCollectedMinor: 100,
        allTimeSandboxCollectedMinor: 150,
      });
      assert.equal(
        (await service.dashboard(other, { month: "2020-10" })).currencies
          .length,
        0,
      );
      await withTenant(other.businessId, async (conn) => {
        assert.equal(
          (
            await conn.query("SELECT * FROM student_rates WHERE client_id=$1", [
              student,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (await conn.query("SELECT * FROM billed_classes")).rowCount,
          0,
        );
      });
      const retainedPreview = await service.preview(ctx, { month: "2020-09" });
      assert.equal(retainedPreview.students[0].existingInvoiceTotalMinor, 500);
      assert.equal(retainedPreview.students[0].billableCount, 1);
      const originalFetch = globalThis.fetch,
        originalScheduling = process.env.SCHEDULING_URL;
      try {
        process.env.SCHEDULING_URL = "http://synthetic-scheduling.invalid";
        globalThis.fetch = async () =>
          new Response(
            JSON.stringify({ items: [], total: 0, truncated: false }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        await service.reconcile(ctx, { month: "2020-09" }, "Bearer synthetic");
        assert.equal(
          (await service.dashboard(ctx, { month: "2020-09" })).students.find(
            (r) => r.clientId === student,
          )!.completedCount,
          0,
        );
        assert.equal(
          (await service.preview(ctx, { month: "2020-09" })).requiresReview
            .length,
          2,
        );
        await withTenant(ctx.businessId, (conn) =>
          projectClass(
            conn,
            ctx.businessId,
            classInput(first, student, "2020-09-15T10:00:00Z", "completed", 3),
          ),
        );
        assert.equal(
          (await service.dashboard(ctx, { month: "2020-09" })).students.find(
            (r) => r.clientId === student,
          )!.completedCount,
          1,
        );
      } finally {
        globalThis.fetch = originalFetch;
        if (originalScheduling === undefined) delete process.env.SCHEDULING_URL;
        else process.env.SCHEDULING_URL = originalScheduling;
      }
      await assert.rejects(
        service.generate(ctx, {
          month: localDate(new Date(), "America/New_York").month,
        }),
        { status: 400 },
      );
      await service.updateSettings(ctx, {
        timeZone: "America/New_York",
        autoDraft: true,
      });
      await service.runAutomatic(new Date("2020-11-02T12:00:00Z"));
      const automatic = await service.preview(ctx, { month: "2020-10" });
      assert.ok(automatic.students[0].existingInvoiceId);
      await service.runAutomatic(new Date("2020-11-03T12:00:00Z"));
      await withTenant(ctx.businessId, async (conn) =>
        assert.equal(
          (
            await conn.query(
              "SELECT * FROM invoices WHERE service_month='2020-10-01'",
            )
          ).rowCount,
          1,
        ),
      );
    } finally {
      service.onApplicationShutdown();
      await tx.query("ROLLBACK");
      tx.release();
      await pool.end();
    }
  },
);
