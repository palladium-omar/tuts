import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

test('platform business and membership tables isolate tenants under runtime role', { skip: !process.env.PLATFORM_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.PLATFORM_TEST_DATABASE_URL });
  const tx = await pool.connect();
  const businessA = randomUUID(), businessB = randomUUID(), userId = randomUUID();
  try {
    const role = await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.rows[0].rolsuper, false);
    assert.equal(role.rows[0].rolbypassrls, false);
    await tx.query('BEGIN');
    await tx.query('INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)', [userId, 'Synthetic isolation user', `${userId}@example.invalid`]);
    await tx.query("SELECT set_config('app.business_id',$1,true)", [businessA]);
    await tx.query('INSERT INTO businesses (business_id,name) VALUES ($1,$2)', [businessA, 'Synthetic business']);
    await tx.query('INSERT INTO memberships (business_id,user_id,role) VALUES ($1,$2,$3)', [businessA, userId, 'owner']);
    assert.equal((await tx.query('SELECT business_id FROM businesses WHERE business_id=$1', [businessA])).rowCount, 1);
    await tx.query("SELECT set_config('app.business_id',$1,true)", [businessB]);
    assert.equal((await tx.query('SELECT business_id FROM businesses WHERE business_id=$1', [businessA])).rowCount, 0);
    assert.equal((await tx.query('SELECT user_id FROM memberships WHERE user_id=$1', [userId])).rowCount, 0);
    await tx.query('SAVEPOINT mismatched');
    await assert.rejects(tx.query('INSERT INTO businesses (business_id,name) VALUES ($1,$2)', [randomUUID(), 'Must be blocked']), (error: unknown) => (error as {code:string}).code === '42501');
    await tx.query('ROLLBACK TO SAVEPOINT mismatched');
    await tx.query('ROLLBACK');
  } finally { await tx.query('ROLLBACK').catch(() => {}); tx.release(); await pool.end(); }
});
