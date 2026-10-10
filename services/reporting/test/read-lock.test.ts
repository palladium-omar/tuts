import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {lockReports} from '../src/projections.js';

test('report readers overlap while projection/merge writers wait and unrelated tenants proceed', {skip:!process.env.REPORTING_TEST_DATABASE_URL}, async()=>{
 const pool=new Pool({connectionString:process.env.REPORTING_TEST_DATABASE_URL,max:4}),a=await pool.connect(),b=await pool.connect(),c=await pool.connect();const business=randomUUID();
 try{
  await Promise.all([a.query('BEGIN'),b.query('BEGIN'),c.query('BEGIN')]);await lockReports(a,business,'read');await b.query("SET LOCAL statement_timeout='500ms'");await lockReports(b,business,'read');
  await lockReports(c,randomUUID());
  const attempted=await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[`reporting:${business}`]);assert.equal(attempted.rows[0].acquired,false);
  await a.query('ROLLBACK');assert.equal((await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[`reporting:${business}`])).rows[0].acquired,false);
  await b.query('ROLLBACK');await lockReports(c,business);
  assert.equal((await a.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) acquired',[`reporting:${business}`])).rows[0].acquired,false);
 }finally{await Promise.all([a.query('ROLLBACK'),b.query('ROLLBACK'),c.query('ROLLBACK')]);a.release();b.release();c.release();await pool.end();}
});
