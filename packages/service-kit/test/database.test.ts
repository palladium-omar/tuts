import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Database, type TransactionOptions } from '../src/database.js';

test('transaction isolation accepts only fixed SQL choices before acquiring a connection', async () => {
  const db = new Database();
  let connections = 0;
  const statements: string[] = [];
  const connection = { query: async (sql: string) => { statements.push(sql); return { rows: [] }; }, release() {} };
  const original = db.pool;
  Object.defineProperty(db, 'pool', { value: { connect: async () => { connections++; return connection; } } });
  try {
    await assert.rejects(db.transaction(async () => {}, { isolation: 'repeatable read; COMMIT' } as unknown as TransactionOptions), /Invalid transaction isolation/);
    assert.equal(connections, 0);
    await db.withTenant(randomUUID(), async () => {}, { isolation: 'repeatable read' });
    assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL REPEATABLE READ', "SELECT set_config('app.business_id',$1,true)", 'COMMIT']);
    statements.length = 0;
    await assert.rejects(db.transaction(async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
    assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
  } finally { await original.end(); }
});

const databaseUrl = process.env.SERVICE_KIT_TEST_DATABASE_URL ?? process.env.BILLING_TEST_DATABASE_URL;
test('real PostgreSQL tenant helper sets isolation before tenant SELECT and clears transaction scope', { skip: !databaseUrl }, async () => {
  const db = new Database();
  const original = db.pool;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  Object.defineProperty(db, 'pool', { value: pool });
  const business = randomUUID();
  try {
    const role = (await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    for (const isolation of ['repeatable read', 'serializable', 'read committed'] as const) {
      await db.withTenant(business, async tx => {
        const settings = (await tx.query("SELECT current_setting('transaction_isolation') isolation,current_setting('app.business_id') business")).rows[0];
        assert.equal(settings.isolation, isolation); assert.equal(settings.business, business);
      }, { isolation });
    }
    await assert.rejects(db.withTenant(business, async () => { throw new Error('rollback fixture'); }, { isolation: 'repeatable read' }), /rollback fixture/);
    await db.transaction(async tx => {
      const settings = (await tx.query("SELECT current_setting('transaction_isolation') isolation,nullif(current_setting('app.business_id',true),'') business")).rows[0];
      assert.equal(settings.isolation, 'read committed'); assert.equal(settings.business, null);
    });
  } finally { await pool.end(); await original.end(); }
});
