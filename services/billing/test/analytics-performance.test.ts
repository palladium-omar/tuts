import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool, type PoolClient} from 'pg';
import type {Database} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {HistoryAnalyticsService} from '../src/history-analytics.js';

test('analytics uses five bounded statements and indexable monthly class bounds on synthetic history', {skip:!process.env.BILLING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.BILLING_TEST_DATABASE_URL}),tx=await pool.connect();const business=randomUUID(),student=randomUUID();
 try{
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await tx.query("SELECT set_config('app.business_id',$1,true)",[business]);
  await tx.query("INSERT INTO billing_settings(business_id,time_zone) VALUES($1,'America/New_York')",[business]);
  await tx.query("INSERT INTO student_rates(business_id,id,client_id,payer_name,currency,unit_price_minor) VALUES($1,$2,$3,'Synthetic','EUR',2500)",[business,randomUUID(),student]);
  await tx.query(`INSERT INTO billing_classes(business_id,class_id,source,client_id,title,starts_at,ends_at,status,revision) SELECT $1,gen_random_uuid(),'internal',$2,'Synthetic',timestamp '2020-01-01'+i*interval '1 day',timestamp '2020-01-01'+i*interval '1 day'+interval '1 hour','completed',1 FROM generate_series(0,3999) i`,[business,student]);
  const calls:Array<{sql:string;values:any[]}>=[];
  const captured=new Proxy(tx,{get(target,key){if(key==='query')return (sql:string,values:any[]=[])=>{calls.push({sql,values});return sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'?Promise.resolve({rows:[]}):(target.query as any).call(target,sql,values);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const db={withTenant:async(_id:string,work:(tx:PoolClient)=>unknown)=>work(captured)} as unknown as Database;
  const ctx:RequestContext={businessId:business,sub:'synthetic',role:'owner',entitlements:['billing'],requestId:randomUUID()};
  const result=await new HistoryAnalyticsService(db).analytics(ctx,{month:'2026-09'});assert.equal(calls.length,5);assert.equal(result.engagement.monthHours,30);assert.equal(result.currencies[0]!.nativeExpectedMinor,75000);assert.equal(result.students.activeThisMonth,1);
  const financial=calls.find(call=>call.sql.includes('WITH currencies'))!;assert.match(financial.sql,/c.starts_at>=/);assert.doesNotMatch(financial.sql,/\(c.starts_at AT TIME ZONE/);
  // Force index choice only to prove the predicate is available as an index condition.
  // This is a structural plan check, not a claim about production latency.
  await tx.query('SET LOCAL enable_seqscan=off');
  const plan=(await tx.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM billing_classes c WHERE NOT c.reconciliation_missing AND c.status IN ('scheduled','completed') AND c.starts_at>=($1::date::timestamp AT TIME ZONE $2) AND c.starts_at<(($1::date+INTERVAL '1 month')::timestamp AT TIME ZONE $2)",['2026-09-01','America/New_York'])).rows[0]['QUERY PLAN'];
  assert.match(JSON.stringify(plan),/Index Cond/);assert.match(JSON.stringify(plan),/starts_at/);
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
});
