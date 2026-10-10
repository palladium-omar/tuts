import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import type {Database} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {HistoryService} from '../src/history.js';
import {HistoryIdentityService} from '../src/history-identity.js';
import {HistoryAnalyticsService} from '../src/history-analytics.js';
const ctx:RequestContext={businessId:randomUUID(),sub:'synthetic-reviewer',role:'owner',entitlements:['billing','clients'],requestId:randomUUID()};
const input=(studentId:string)=>({status:'linked',studentId,expectedWorkRevision:1,expectedIdentityRevision:0});
test('identity review rejects ungranted, malformed and unavailable student verification without a write',async()=>{
 let writes=0,requests=0;const service=new HistoryIdentityService({withTenant:async()=>{writes++;throw new Error('must not write');}} as unknown as Database);
 service.fetchStudent=async()=>{requests++;return new Response('{}',{status:404});};const id=randomUUID(),student=randomUUID();
 for(const denied of [{...ctx,role:'student' as const},{...ctx,role:'tutor' as const,accessScope:'students' as const},{...ctx,permissions:['billing.read','reporting.financial','billing.write']},{...ctx,entitlements:['billing']}])await assert.rejects(service.review(denied,id,input(student),'Bearer synthetic'));
 await assert.rejects(service.review(ctx,id,{...input(student),studentName:'guess'},'Bearer synthetic'));
 await assert.rejects(service.review(ctx,id,input(student),undefined),/Verified authorization/);
 assert.equal(requests,0);assert.equal(writes,0);
 await assert.rejects(service.review(ctx,id,input(student),'Bearer synthetic'),/accessible canonical CRM student/);
 service.fetchStudent=async()=>new Response(JSON.stringify({item:{id:student,kind:'payer'}}));await assert.rejects(service.review(ctx,id,input(student),'Bearer synthetic'));
 service.fetchStudent=async()=>{throw new Error('secret upstream URL/token');};await assert.rejects(service.review(ctx,id,input(student),'Bearer synthetic'),error=>error instanceof Error&&error.message==='Student verification unavailable');assert.equal(writes,0);
});
test('reviewed work rows distinguish identical names, unite spelling variants, preserve sources, isolate tenants and stale revisions', {skip:!process.env.BILLING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.BILLING_TEST_DATABASE_URL}),tx=await pool.connect();const a=randomUUID(),b=randomUUID();
 try{
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const captured=new Proxy(tx,{get(target,key){if(key==='query')return (sql:string,...args:any[])=>sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'?Promise.resolve({rows:[]}):(target.query as any).call(target,sql,...args);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  async function tenant<T>(id:string,work:(conn:PoolClient)=>Promise<T>){await tx.query('SAVEPOINT identity_fixture');try{await tx.query("SELECT set_config('app.business_id',$1,true)",[id]);const result=await work(captured);await tx.query('RELEASE SAVEPOINT identity_fixture');return result;}catch(error){await tx.query('ROLLBACK TO SAVEPOINT identity_fixture');await tx.query('RELEASE SAVEPOINT identity_fixture');throw error;}}
  const db={withTenant:tenant} as unknown as Database,history=new HistoryService(db),identities=new HistoryIdentityService(db),analytics=new HistoryAnalyticsService(db);
  identities.fetchStudent=async(_service,path,options)=>{assert.equal(new Headers(options?.headers).get('authorization'),'Bearer synthetic');const id=path.split('/').at(-1)!;assert.ok([a,b].includes(id));return new Response(JSON.stringify({item:{id,kind:'student',displayName:'Same Name',email:'not-stored@example.test'}}));};
  const bytes=Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Invoice Status\n2026-08-01,Same Name,1,40,Paid\n2026-09-01,Same Name,1,40,Paid\n2026-09-02,Spelling Variant,1,40,Paid');
  const preview=await history.preview(ctx,{originalname:'synthetic.csv',buffer:bytes},{kind:'work',currency:'EUR',countAsClasses:true});await history.commit(ctx,{token:preview.token},'fixture');
  const rows=(await history.workLog(ctx,{limit:200})).items,older=rows.find(row=>row.date==='2026-08-01')!,same=rows.find(row=>row.date==='2026-09-01')!,variant=rows.find(row=>row.date==='2026-09-02')!;
  assert.equal((await analytics.analytics(ctx,{month:'2026-09'})).students.tracked,null);
  await identities.review(ctx,older.id,input(a),'Bearer synthetic');await identities.review(ctx,same.id,input(b),'Bearer synthetic');
  await identities.review(ctx,variant.id,{status:'ambiguous',expectedWorkRevision:1,expectedIdentityRevision:0,reason:'More than one plausible contact'},undefined);
  assert.equal((await analytics.analytics(ctx,{month:'2026-09'})).students.tracked,null);
  await identities.review(ctx,variant.id,{...input(b),expectedIdentityRevision:1,reason:'Tutor checked the original appointment'},'Bearer synthetic');
  const linked=await analytics.analytics(ctx,{month:'2026-09'});assert.equal(linked.students.tracked,2);assert.equal(linked.students.activeThisMonth,1);assert.equal(linked.students.activePreviousMonth,1);assert.equal(linked.students.lostFromPreviousMonth,1);assert.equal(linked.engagement.averageClassFrequency,2);assert.equal(linked.coverage.studentIdentity,'reviewed_work_rows_and_native_student_ids');
  assert.deepEqual((await history.download(ctx,preview.importId)).file_bytes,bytes);assert.equal((await history.workLog(ctx,{})).items.find(row=>row.id===variant.id)!.studentName,'Spelling Variant');
  await assert.rejects(identities.review(ctx,variant.id,{...input(a),expectedIdentityRevision:1},'Bearer synthetic'),/identity_review_revision_conflict/);
  await assert.rejects(identities.review({...ctx,businessId:randomUUID()},variant.id,{...input(a),expectedIdentityRevision:2},'Bearer synthetic'),/work_log_not_found/);
  await history.editWork(ctx,variant.id,{notes:'Corrected note',revision:1});assert.equal((await history.workLog(ctx,{})).items.find(row=>row.id===variant.id)!.identity.status,'stale');assert.equal((await analytics.analytics(ctx,{month:'2026-09'})).students.tracked,null);
  await assert.rejects(identities.review(ctx,variant.id,{...input(b),expectedIdentityRevision:2},'Bearer synthetic'),/work_log_revision_conflict/);
  await identities.review(ctx,variant.id,{...input(b),expectedWorkRevision:2,expectedIdentityRevision:2},'Bearer synthetic');
  await tenant(ctx.businessId,conn=>conn.query('INSERT INTO billing_student_aliases(business_id,source_id,target_id) VALUES($1,$2,$3)',[ctx.businessId,b,a]));
  const merged=await analytics.analytics(ctx,{month:'2026-09'});assert.equal(merged.students.tracked,1);assert.equal(merged.students.lostFromPreviousMonth,0);assert.equal((await history.workLog(ctx,{})).items.find(row=>row.id===variant.id)!.identity.studentId,a);
  await tenant(ctx.businessId,async conn=>{const stored=(await conn.query('SELECT * FROM billing_work_identities WHERE work_id=$1',[variant.id])).rows[0];assert.equal(stored.reviewed_by,ctx.sub);assert.equal(stored.reason,'');assert.equal('email' in stored,false);});
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
});
