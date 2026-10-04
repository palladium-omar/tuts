import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Database } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import { ClassLedgerController, refreshClass } from "../src/class-ledger.js";
test(
  "PostgreSQL ledger preserves provider status, requires explicit completion, revisions, tenant scope and overlap conflicts",
  { skip: !process.env.SCHEDULING_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
        connectionString: process.env.SCHEDULING_TEST_DATABASE_URL,
      }),
      tx = await pool.connect();
    const ctx: RequestContext = {
        businessId: randomUUID(),
        sub: "synthetic-staff",
        role: "owner",
        entitlements: ["scheduling"],
        requestId: randomUUID(),
      },
      other = { ...ctx, businessId: randomUUID() };
    const withTenant = async <T>(
      id: string,
      work: (conn: PoolClient) => Promise<T>,
    ) => {
      await tx.query("SAVEPOINT ledger_operation");
      try {
        await tx.query("SELECT set_config('app.business_id',$1,true)", [id]);
        const result = await work(tx);
        await tx.query("RELEASE SAVEPOINT ledger_operation");
        return result;
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT ledger_operation");
        throw error;
      }
    };
    const controller = new ClassLedgerController({
        withTenant,
      } as unknown as Database),
      external = randomUUID(),
      internal = randomUUID(),
      student = randomUUID();
    try {
      await tx.query("BEGIN");
      await withTenant(ctx.businessId, async (conn) => {
        await conn.query(
          "INSERT INTO external_sessions(id,business_id,connection_id,provider,external_id,owner_user_id,title,starts_at,ends_at,status) VALUES($1,$2,$3,'calcom','synthetic', 'synthetic-staff','Synthetic external','2020-10-01T00:30:00Z','2020-10-01T01:30:00Z','scheduled')",
          [external, ctx.businessId, randomUUID()],
        );
        await conn.query(
          "INSERT INTO sessions(id,business_id,client_id,title,starts_at,ends_at,status,created_by) VALUES($1,$2,$3,'Synthetic internal','2020-09-20T10:00:00Z','2020-09-20T11:00:00Z','completed','synthetic-staff')",
          [internal, ctx.businessId, student],
        );
      });
      const ledger = await controller.list(ctx, {
        month: "2020-09",
        timeZone: "America/New_York",
      });
      assert.equal(ledger.total, 2);
      assert.equal(
        ledger.items.find((r) => r.id === external)!.status,
        "scheduled",
      );
      assert.equal(
        ledger.items.find((r) => r.id === internal)!.status,
        "completed",
      );
      await withTenant(ctx.businessId, async (conn) =>
        assert.equal(
          (
            await conn.query(
              "SELECT * FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='scheduling.class-updated.v1'",
              [ctx.businessId],
            )
          ).rowCount,
          2,
        ),
      );
      assert.equal(
        (
          await controller.list(other, {
            month: "2020-09",
            timeZone: "America/New_York",
          })
        ).total,
        0,
      );
      const annotation = await controller.annotate(ctx, "external", external, {
        clientId: student,
        status: "completed",
      });
      assert.equal(annotation.item.status, "completed");
      assert.equal(annotation.item.providerStatus, "scheduled");
      assert.equal(annotation.item.revision, 2);
      await withTenant(ctx.businessId, async (conn) => {
        assert.equal(
          await refreshClass(conn, ctx.businessId, "external", external),
          undefined,
        );
        await conn.query(
          "UPDATE external_sessions SET status='cancelled' WHERE id=$1",
          [external],
        );
        const refreshed = await refreshClass(
          conn,
          ctx.businessId,
          "external",
          external,
        );
        assert.equal(refreshed!.status, "completed");
        assert.equal(refreshed!.providerStatus, "cancelled");
        assert.equal(refreshed!.revision, 3);
      });
      await assert.rejects(
        controller.annotate(other, "external", external, {
          status: "completed",
        }),
        { status: 404 },
      );
      await withTenant(ctx.businessId, async (conn) => {
        await conn.query(
          "INSERT INTO sessions(id,business_id,client_id,title,starts_at,ends_at,created_by) VALUES($1,$2,$3,'Synthetic overlap','2020-09-20T10:00:00Z','2020-09-20T11:00:00Z','synthetic-staff')",
          [randomUUID(), ctx.businessId, student],
        );
      });
      await assert.rejects(
        controller.annotate(ctx, "internal", internal, { status: "scheduled" }),
        { status: 409 },
      );
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
      await pool.end();
    }
  },
);
