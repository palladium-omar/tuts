import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Reflector} from '@nestjs/core';
import {Pool,type PoolClient} from 'pg';
import type {Database,EventBus} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {ReconciliationController,ReconciliationService} from '../src/reconciliation.js';
import {HistoryService} from '../src/history.js';
import {HistoryAnalyticsService} from '../src/history-analytics.js';
const ctx:RequestContext={sub:'synthetic-reviewer',businessId:randomUUID(),role:'owner',entitlements:['billing','clients','payments'],permissions:['billing.read','billing.write','reporting.financial','clients.read','payments.read'],accessScope:'business',policyVersion:1,studentIds:[],requestId:randomUUID()};
const decision=()=>({source:{kind:'imported',id:randomUUID(),revision:1},choice:'new',studentIds:[],workLinks:[],confirmed:true});
function isolated(){let transactions=0;const db={withTenant:async()=>{transactions++;throw new Error('unexpected_transaction');}} as unknown as Database;return {service:new ReconciliationService(db,{subscribe(){}} as unknown as EventBus),transactions:()=>transactions};}

test('reconciliation service and controller reject learners and scoped staff before any data or external reads',async()=>{
 const {service,transactions}=isolated();for(const candidate of [{...ctx,role:'student' as const},{...ctx,role:'parent' as const},{...ctx,role:'tutor' as const,accessScope:'students' as const},{...ctx,permissions:['billing.read']}])await assert.rejects(service.list(candidate,{}),/business access|not permitted/);assert.equal(transactions(),0);
 const reflector=new Reflector();assert.deepEqual(reflector.get('palladium.roles',ReconciliationController),['owner','admin','tutor']);assert.deepEqual(reflector.get('palladium.permissions',ReconciliationController),['billing.read','reporting.financial']);assert.equal(reflector.get('palladium.student-scoped',ReconciliationController),undefined);
 for(const method of ['preview','publish','historicalReceipt','allocate','adjust'] as const)assert.deepEqual(reflector.get('palladium.permissions',ReconciliationController.prototype[method]),['billing.read','reporting.financial','billing.write']);
});
test('canonical identity verification checks kind and access outside transaction with bounded bodies',async()=>{
 const {service,transactions}=isolated();let calls=0;service.fetchService=async()=>{calls++;assert.equal(transactions(),0);return new Response(JSON.stringify({item:{id:randomUUID(),kind:'payer'}}));};
 await assert.rejects(service.preview(ctx,{...decision(),studentIds:[randomUUID()]},'Bearer signed'),/canonical student/);
 assert.equal(calls,1);assert.equal(transactions(),0);
 await assert.rejects(service.preview({...ctx,permissions:['billing.read','billing.write','reporting.financial']},{...decision(),studentIds:[randomUUID()]},'Bearer signed'),/not permitted/);assert.equal(calls,1);
 service.fetchService=async()=>new Response(' '.repeat(65537));await assert.rejects(service.preview(ctx,{...decision(),payerId:randomUUID()},'Bearer signed'),/exceeds limit/);assert.equal(transactions(),0);
 service.fetchService=async()=>new Response('{}',{status:403});await assert.rejects(service.preview(ctx,{...decision(),payerId:randomUUID()},'Bearer signed'),/access denied/);assert.equal(transactions(),0);
});
test('student family identity lookups use bounded concurrency and all finish before the transaction',async()=>{
 const {service,transactions}=isolated();let active=0,maxActive=0,finished=0;const ids=Array.from({length:12},()=>randomUUID());
 service.fetchService=async(_service,path)=>{active++;maxActive=Math.max(maxActive,active);assert.equal(transactions(),0);await new Promise(resolve=>setTimeout(resolve,3));active--;finished++;return new Response(JSON.stringify({item:{id:String(path).split('/')[3],kind:'student'}}));};
 await assert.rejects(service.preview(ctx,{...decision(),studentIds:ids},'Bearer signed'),/unexpected_transaction/);assert.equal(finished,12);assert.equal(maxActive,6);assert.equal(transactions(),1);
});
test('payment recovery validates page outside transaction and requires payments capability',async()=>{
 const {service,transactions}=isolated();service.fetchService=async()=>new Response(JSON.stringify({items:[{paymentId:randomUUID(),amountMinor:10}],total:1,limit:1,offset:0}));
 await assert.rejects(service.sync(ctx,{limit:1,offset:0,confirmed:true},'Bearer signed'),/recovery response is invalid/);assert.equal(transactions(),0);
 await assert.rejects(service.sync({...ctx,entitlements:['billing']},{confirmed:true},'Bearer signed'),/Payments is not enabled/);
 await assert.rejects(service.sync({...ctx,permissions:['billing.read','billing.write','reporting.financial']},{confirmed:true},'Bearer signed'),/not permitted/);
});
test('external body deadline cancels a stalled stream before any transaction',async()=>{
 const {service,transactions}=isolated();let cancelled=false;service.fetchService=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
 await assert.rejects((service as any).boundedJson('clients','/identity','Bearer signed',65536,20),/deadline exceeded/);assert.equal(cancelled,true);assert.equal(transactions(),0);
});
test('mutations require explicit confirmation and money is positive exact integer',async()=>{
 const {service,transactions}=isolated();for(const amountMinor of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(service.allocate(ctx,{receiptId:randomUUID(),invoiceId:randomUUID(),amountMinor,currency:'EUR',confirmed:true},'key'));
 await assert.rejects(service.historicalReceipt(ctx,{amountMinor:1,currency:'EUR',paidOn:'2026-02-30',reference:'ref',reason:'evidence',confirmed:true},'key'));
 await assert.rejects(service.publish(ctx,{...decision(),confirmed:false},'key','Bearer signed'));assert.equal(transactions(),0);
});

test('ordinary PostgreSQL workflow stages duplicate documents, preserves totals, publishes/retries and recovers receipts',{skip:!process.env.BILLING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.BILLING_TEST_DATABASE_URL}),tx=await pool.connect(),business=randomUUID(),tenant={...ctx,businessId:business};
 try{
  const role=(await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  await tx.query('BEGIN');
  const db={withTenant:async<T>(id:string,work:(tx:PoolClient)=>Promise<T>)=>{await tx.query('SAVEPOINT reconciliation_api_test');try{await tx.query("SELECT set_config('app.business_id',$1,true)",[id]);const result=await work(tx);await tx.query('RELEASE SAVEPOINT reconciliation_api_test');return result;}catch(error){await tx.query('ROLLBACK TO SAVEPOINT reconciliation_api_test');await tx.query('RELEASE SAVEPOINT reconciliation_api_test');throw error;}}} as unknown as Database;
  const service=new ReconciliationService(db,{subscribe(){}} as unknown as EventBus),history=new HistoryService(db),analytics=new HistoryAnalyticsService(db);
  const workPreview=await history.preview(tenant,{originalname:'work.csv',buffer:Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Invoice Status\n2026-09-01,Test Family,1,500,Paid')},{kind:'work',currency:'EUR'});await history.commit(tenant,{token:workPreview.token},'work-import');
  const work=(await history.workLog(tenant,{})).items[0]!;const before=(await analytics.analytics(tenant,{month:'2026-09'})).currencies[0]!;assert.equal(before.totalRecordedRevenueMinor,50000);
  const invoice=await history.manualInvoice(tenant,{date:'2026-10-01',studentName:'Test Family',amountMinor:50000,currency:'EUR',status:'paid',invoiceNumber:'TEST-SAME'},'invoice');
  const duplicate=await history.manualInvoice(tenant,{date:'2026-10-01',studentName:'Test Family',amountMinor:50000,currency:'EUR',status:'paid',invoiceNumber:'TEST-SAME'},'invoice-duplicate');
  assert.equal((await service.list(tenant,{})).total,2);assert.equal((await history.invoiceHistory(tenant,{})).items[0]!.reconciliationState,'unresolved');
  const input={source:{kind:'imported',id:invoice.id,revision:1},choice:'new',studentIds:[],workLinks:[{workId:work.id,revision:1,amountMinor:50000}],confirmed:true};
  const preview=await service.preview(tenant,input,undefined);assert.equal(preview.after[0]!.recordedPaidMinor,50000);assert.equal((await service.list(tenant,{})).total,2);
  const published=await service.publish(tenant,input,'publish',undefined);assert.deepEqual(await service.publish(tenant,input,'publish',undefined),published);
  const accepted=(await service.list(tenant,{state:'accepted'})).items[0]!;assert.equal(accepted.source.id,invoice.id);const detail=await service.detail(tenant,accepted.id);assert.equal(detail.work[0]!.linkedMinor,50000);
  await assert.rejects(history.editInvoice(tenant,invoice.id,{status:'pending',revision:1}),/immutable/);
  const alias={source:{kind:'imported',id:duplicate.id,revision:1},choice:'existing',invoiceId:accepted.id,invoiceRevision:accepted.revision,studentIds:[],workLinks:[],confirmed:true};await service.publish(tenant,alias,'alias',undefined);
  const after=(await analytics.analytics(tenant,{month:'2026-09'})).currencies[0]!;assert.equal(after.totalRecordedRevenueMinor,50000);assert.equal(after.unresolvedInvoices,0);assert.equal(after.invoicedMinor,50000);
  const providerInvoice=randomUUID(),receipt={paymentId:randomUUID(),invoiceId:providerInvoice,connectionId:randomUUID(),provider:'stripe',providerReference:'test-recovery',amountMinor:50000,currency:'EUR',confirmedAt:'2026-10-02T00:00:00.000Z',simulated:false};
  // Recovery uses an authoritative native invoice, without external calls or customer records.
  await db.withTenant(business,conn=>conn.query("INSERT INTO invoices(business_id,id,payer_name,currency,items,total_minor,status,issued_at) VALUES($1,$2,'Recovery','EUR','[]',50000,'issued',now())",[business,providerInvoice]));
  service.fetchService=async()=>new Response(JSON.stringify({items:[receipt],total:1,limit:50,offset:0}));await service.sync(tenant,{confirmed:true},'Bearer signed');await service.sync(tenant,{confirmed:true},'Bearer signed');
  const receipts=await service.receipts(tenant,{});assert.equal(receipts.items.filter(row=>row.category==='provider').length,1);assert.equal((await service.detail(tenant,accepted.id)).receipts.length,0);const recoveredDetail=await service.detail(tenant,providerInvoice);assert.equal(recoveredDetail.receipts.length,1);assert.equal(recoveredDetail.receipts[0]!.allocatedMinor,50000);assert.equal(recoveredDetail.invoice.outstandingMinor,0);assert.equal(recoveredDetail.invoice.recordedPaidMinor,50000);assert.equal((await service.list({...tenant,businessId:randomUUID()},{})).total,0);
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
});
