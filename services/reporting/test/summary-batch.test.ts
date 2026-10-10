import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { ReportingService } from '../src/reporting.service.js';
import { legacySummary } from './legacy-summary.fixture.js';
const ctx:RequestContext={sub:'synthetic-actor',businessId:randomUUID(),role:'owner',entitlements:['reporting','billing'],requestId:randomUUID()};
const period={month:'2026-10',timeZone:'Africa/Casablanca'};
const normalized=(value:unknown)=>JSON.parse(JSON.stringify(value));
function stub(aliases?:{student_id?:string;depth?:number;cycle?:boolean}){
 const calls:{sql:string;values:any[]}[]=[];
 const tx={query:async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.includes('WITH RECURSIVE roots'))return {rows:values[0].map((id:string)=>({requested_id:id,student_id:aliases?.student_id??id,depth:aliases?.depth??0,cycle:aliases?.cycle??false}))};
  if(sql.includes('WITH period AS'))return {rows:values[0].map((id:string)=>({student_id:id}))};
  return {rows:[]};
 }} as unknown as PoolClient;
 return {service:new ReportingService({withTenant:async(_business:string,work:(connection:PoolClient)=>unknown)=>work(tx)} as unknown as Database),calls};
}
test('one, 50 and 100 cards use four queries or five with finance, preserving null gaps',async()=>{
 for(const financial of [false,true])for(const size of [1,50,100]){
  const {service,calls}=stub(),ids=Array.from({length:size},()=>randomUUID()),result=await service.summaries(ctx,ids,period,financial);
  assert.equal(calls.length,financial?5:4);assert.match(calls[0]!.sql,/pg_advisory_xact_lock_shared/);
  assert.deepEqual(result.items.map(item=>item.studentId),ids);
  for(const item of result.items){assert.equal(item.bookings.completed,null);assert.equal(item.homework.completed,null);assert.equal(item.resources.materials,null);assert.equal(item.activity.activeSeconds,0);assert.equal(item.partial,true);assert.equal(item.asOf,null);assert.equal('financial' in item,financial);}
  assert.equal(calls.some(call=>call.sql.includes('report_finance_snapshots')),financial);
  assert.deepEqual(calls[3]!.values[3],financial?['scheduling','learning','billing']:['scheduling','learning']);
 }
});
test('requested/canonical authorization and financial grants fail before aggregate reads',async()=>{
 const id=randomUUID(),target=randomUUID(),scoped={...ctx,role:'tutor' as const,accessScope:'students' as const,studentIds:[id]};let f=stub({student_id:target});
 await assert.rejects(f.service.summaries(scoped,[randomUUID()],period),/Student access/);assert.equal(f.calls.length,0);
 await assert.rejects(f.service.summaries(scoped,[id],period),/Student access/);assert.equal(f.calls.length,2);
 f=stub();await assert.rejects(f.service.summaries({...ctx,permissions:['reporting.read']},[id],period,true),/not permitted/);assert.equal(f.calls.length,0);
 await assert.rejects(f.service.summaries({...ctx,entitlements:['reporting']},[id],period,true),/Billing is not enabled/);assert.equal(f.calls.length,0);
});
test('requested order, exact-id deduplication and alias cards are preserved',async()=>{
 const alias=randomUUID(),target=randomUUID(),{service,calls}=stub({student_id:target}),result=await service.summaries(ctx,[alias,target,alias],period);
 assert.deepEqual(result.items.map(item=>item.studentId),[target,target]);assert.deepEqual(calls[1]!.values[0],[alias,target]);assert.deepEqual(calls[2]!.values[0],[target]);
});
test('cyclic and overlong aliases fail before aggregate reads',async()=>{
 for(const [state,error] of [[{cycle:true,depth:2},/requires reconciliation/],[{depth:50},/chain exceeds limit/],[{depth:50,cycle:true},/chain exceeds limit/]] as const){const {service,calls}=stub(state);await assert.rejects(service.summaries(ctx,[randomUUID()],period),error);assert.equal(calls.length,2);}
});
test('PostgreSQL batch matches prior summary output with tenant RLS, aliases, timezone and coverage', {skip:!process.env.REPORTING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.REPORTING_TEST_DATABASE_URL,connectionTimeoutMillis:3000}),tx=await pool.connect();
 try{
  await tx.query('BEGIN');const role=(await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  assert.ok((await tx.query("SELECT to_regclass('report_classes') present")).rows[0].present,'Reporting local schema must be migrated');
  let statements=0;const counted=new Proxy(tx,{get(target,key){if(key==='query')return (...args:any[])=>{statements++;return (target.query as any).apply(target,args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  async function tenant<T>(businessId:string,work:(connection:PoolClient)=>Promise<T>){await tx.query('SAVEPOINT batch_test');try{await tx.query("SELECT set_config('app.business_id',$1,true)",[businessId]);const r=await work(counted);await tx.query('RELEASE SAVEPOINT batch_test');return r;}catch(e){await tx.query('ROLLBACK TO SAVEPOINT batch_test');await tx.query('RELEASE SAVEPOINT batch_test');throw e;}}
  const service=new ReportingService({withTenant:tenant} as unknown as Database),ids=Array.from({length:50},()=>randomUUID()),target=ids[2]!,other={...ctx,businessId:randomUUID()};
  await tenant(ctx.businessId,async conn=>{
   await conn.query('INSERT INTO report_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,1),($1,$3,$4,1)',[ctx.businessId,ids[0],ids[1],target]);
   for(const [index,status] of ['scheduled','completed','cancelled','no_show'].entries()){
    await conn.query(`INSERT INTO report_classes(business_id,source,class_id,student_id,starts_at,ends_at,status,revision,observed_at) VALUES($1,'internal',$2,$3,'2026-10-01T00:30:00Z','2026-10-01T01:30:00Z',$4,1,'2026-10-02T00:00:00Z')`,[ctx.businessId,randomUUID(),target,status]);
    await conn.query(`INSERT INTO report_assignments(business_id,assignment_id,student_id,status,due_at,revision,observed_at) VALUES($1,$2,$3,$4,'2026-10-01T00:30:00Z',1,'2026-10-03T00:00:00Z')`,[ctx.businessId,randomUUID(),target,['assigned','submitted','completed','needs_revision'][index]]);
   }
   await conn.query(`INSERT INTO report_assignments(business_id,assignment_id,student_id,status,revision,observed_at) VALUES($1,$2,$3,'assigned',1,'2026-10-04T00:00:00Z')`,[ctx.businessId,randomUUID(),ids[3]]);
   await conn.query(`INSERT INTO report_resources(business_id,resource_id,student_id,assignment_id,kind,revision,observed_at) VALUES($1,$2,$3,null,'file',1,'2026-10-05T00:00:00Z'),($1,$4,$3,$5,'file',1,'2026-10-06T00:00:00Z'),($1,$6,$7,null,'file',1,'2026-10-06T00:00:00Z')`,[ctx.businessId,randomUUID(),target,randomUUID(),randomUUID(),randomUUID(),ids[4]]);
   await conn.query(`INSERT INTO activity_receipts(business_id,actor_id,session_id,sequence,student_id,claimed_seconds,accepted_seconds,received_at) VALUES($1,'synthetic',$2,1,$3,30,20,'2026-10-01T00:30:00Z'),($1,'synthetic',$2,2,$3,30,30,'2026-11-01T00:00:00Z')`,[ctx.businessId,randomUUID(),target]);
   for(const id of [target,ids[3],ids[5]])await conn.query(`INSERT INTO report_coverage(business_id,student_id,source,month,time_zone,status,as_of) VALUES($1,$2,'learning','2026-10','Africa/Casablanca','complete','2026-10-01T00:00:00Z')`,[ctx.businessId,id]);
   await conn.query(`INSERT INTO report_coverage(business_id,student_id,source,month,time_zone,status,as_of,reason) VALUES($1,$2,'scheduling','2026-10','Africa/Casablanca','unavailable',null,'Synthetic unavailable'),($1,$3,'scheduling','2026-10','Africa/Casablanca','unavailable','2026-10-01T00:00:00Z','Synthetic retained history')`,[ctx.businessId,ids[6],ids[7]]);
   const totals=[{currency:'EUR',billedMinor:12000,collectedMinor:6000,simulatedMinor:1000,outstandingMinor:5000},{currency:'USD',billedMinor:2000,collectedMinor:0,simulatedMinor:0,outstandingMinor:2000}];
   await conn.query(`INSERT INTO report_finance_snapshots(business_id,student_id,totals,invoice_count,as_of,complete) VALUES($1,$2,$3::jsonb,2,'2026-10-07T00:00:00Z',true),($1,$4,$3::jsonb,2,'2026-10-07T00:00:00Z',false)`,[ctx.businessId,target,JSON.stringify(totals),ids[3]]);
  });
  await tenant(other.businessId,async conn=>{
   await conn.query('INSERT INTO report_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,1)',[other.businessId,ids[0],ids[8]]);
   await conn.query(`INSERT INTO report_classes(business_id,source,class_id,student_id,starts_at,ends_at,status,revision) VALUES($1,'internal',$2,$3,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z','completed',1)`,[other.businessId,randomUUID(),target]);
  });
  for(const financial of [false,true]){
   const expected=await tenant(ctx.businessId,async conn=>{const rows=[];for(const id of ids)rows.push(await legacySummary(conn,ctx,id,period,financial));return rows;}),before=statements,actual=await service.summaries(ctx,ids,period,financial);assert.equal(statements-before,financial?5:4,'real PG query count stays constant for 50 cards');
   assert.deepEqual(normalized(actual.items),normalized(expected));assert.equal(actual.items[0]!.studentId,target);assert.equal(actual.items[0]!.bookings.completed,1);assert.equal(actual.items[0]!.homework.completed,1);assert.equal(actual.items[0]!.activity.activeSeconds,20);
   assert.equal(actual.items[3]!.coverage.learning.status,'partial');assert.equal(actual.items[5]!.homework.completed,0);assert.equal(actual.items[6]!.bookings.completed,null);assert.equal(actual.items[7]!.bookings.completed,0);assert.equal(actual.items[0]!.asOf,'2026-11-01T00:00:00.000Z');
   if(financial){assert.equal(actual.items[0]!.financial?.totalsByCurrency?.length,2);assert.equal(actual.items[3]!.financial?.totalsByCurrency,null);}
   const isolated=await service.summaries(other,[ids[0]!,target],period,financial);assert.equal(isolated.items[0]!.studentId,ids[8]);assert.equal(isolated.items[0]!.homework.completed,null);assert.equal(isolated.items[1]!.bookings.completed,1);assert.equal(isolated.items[1]!.homework.completed,null);if(financial)assert.equal(isolated.items[1]!.financial?.totalsByCurrency,null);
  }
  const scoped={...ctx,role:'tutor' as const,accessScope:'students' as const,studentIds:[ids[0]!]};await assert.rejects(service.summaries(scoped,[ids[0]!],period),/Student access/);await service.summaries({...scoped,studentIds:[ids[0]!,target]},[ids[0]!],period);
  const chain=Array.from({length:51},()=>randomUUID()),cycle=[randomUUID(),randomUUID()];await tenant(ctx.businessId,async conn=>{
   await conn.query('INSERT INTO report_student_aliases(business_id,source_id,target_id,revision) SELECT $1,source_id,target_id,1 FROM unnest($2::uuid[],$3::uuid[]) pair(source_id,target_id)',[ctx.businessId,chain.slice(0,50),chain.slice(1)]);
   await conn.query('INSERT INTO report_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,1),($1,$3,$2,1)',[ctx.businessId,...cycle]);
  });
  assert.equal((await service.summaries(ctx,[chain[1]!],period)).items[0]!.studentId,chain[50]);await assert.rejects(service.summaries(ctx,[chain[0]!],period),/chain exceeds limit/);await assert.rejects(service.summaries(ctx,[cycle[0]!],period),/requires reconciliation/);
 }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release();await pool.end();}
});
