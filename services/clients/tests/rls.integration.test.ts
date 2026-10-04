import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

// Use the already-migrated clients database with its normal runtime role.
// All fixture writes are rolled back. A superuser cannot validate forced RLS.
test(
  "PostgreSQL RLS hides another business and forbids mismatched tenant inserts",
  { skip: !process.env.CLIENTS_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.CLIENTS_TEST_DATABASE_URL,
    });
    const tx = await pool.connect();
    const businessA = randomUUID(),
      businessB = randomUUID(),
      clientId = randomUUID();
    try {
      const role = await tx.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      assert.equal(role.rows[0].rolsuper, false, "test requires non-superuser");
      assert.equal(
        role.rows[0].rolbypassrls,
        false,
        "test requires no BYPASSRLS",
      );
      await tx.query("BEGIN");
      await tx.query("SELECT set_config('app.business_id',$1,true)", [
        businessA,
      ]);
      await tx.query(
        "INSERT INTO clients (business_id,id,kind,display_name) VALUES ($1,$2,$3,$4)",
        [businessA, clientId, "student", "Synthetic isolation fixture"],
      );
      assert.equal(
        (await tx.query("SELECT id FROM clients WHERE id=$1", [clientId]))
          .rowCount,
        1,
      );
      await tx.query(
        "INSERT INTO client_fields (business_id,id,key,label,type) VALUES ($1,$2,'synthetic','Synthetic','text')",
        [businessA, clientId],
      );
      assert.equal(
        (await tx.query("SELECT id FROM client_fields WHERE id=$1", [clientId]))
          .rowCount,
        1,
      );
      await tx.query("SELECT set_config('app.business_id',$1,true)", [
        businessB,
      ]);
      assert.equal(
        (await tx.query("SELECT id FROM clients WHERE id=$1", [clientId]))
          .rowCount,
        0,
      );
      assert.equal(
        (await tx.query("SELECT id FROM client_fields WHERE id=$1", [clientId]))
          .rowCount,
        0,
      );
      await tx.query("SAVEPOINT field_mismatched");
      await assert.rejects(
        tx.query(
          "INSERT INTO client_fields (business_id,id,key,label,type) VALUES ($1,$2,'forbidden','Forbidden','text')",
          [businessA, randomUUID()],
        ),
        (error: unknown) => (error as { code: string }).code === "42501",
      );
      await tx.query("ROLLBACK TO SAVEPOINT field_mismatched");
      await tx.query("SAVEPOINT mismatched");
      await assert.rejects(
        tx.query(
          "INSERT INTO clients (business_id,id,kind,display_name) VALUES ($1,$2,$3,$4)",
          [businessA, randomUUID(), "student", "Must be blocked"],
        ),
        (error: unknown) => (error as { code: string }).code === "42501",
      );
      await tx.query("ROLLBACK TO SAVEPOINT mismatched");
      await tx.query("ROLLBACK");
      const context = await tx.query(
        "SELECT nullif(current_setting('app.business_id',true),'') AS business",
      );
      assert.equal(
        context.rows[0].business,
        null,
        "transaction-local tenant must be cleared",
      );
    } finally {
      await tx.query("ROLLBACK").catch(() => {});
      tx.release();
      await pool.end();
    }
  },
);
