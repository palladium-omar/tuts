import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import type {Database,EventBus} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {StudentFinanceService} from '../src/student-finance.js';
import {HistoryService} from '../src/history.js';
import {ReconciliationService} from '../src/reconciliation.js';
import {allocateReceipt,adjustInvoice,importConfirmedReceipts,publishDecision,recordHistoricalReceipt} from '../src/reconciliation-engine.js';
const ctx:RequestContext={sub:'synthetic',businessId:randomUUID(),role:'owner',entitlements:['billing'],permissions:['billing.read','reporting.financial','billing.write'],requestId:randomUUID(),accessScope:'business',studentIds:[],policyVersion:1};
test('direct student finance denies learners, missing financial capability and out-of-scope staff before IO',async()=>{
 const service=new StudentFinanceService({withTenant(){throw new Error('unexpected_database');}} as unknown as Database,{subscribe(){}} as unknown as EventBus),studentId=randomUUID();
 for(const role of ['student','parent'] as const)await assert.rejects(service.finance({...ctx,role},{studentId}),/staff access/);
 await assert.rejects(service.finance({...ctx,permissions:['billing.read']},{studentId}),/not permitted/);
 await assert.rejects(service.finance({...ctx,role:'tutor',accessScope:'students',studentIds:[randomUUID()]},{studentId}),/Student access is not granted/);
});
test('reviewed imported family obligations expose distinct evidence, credits/refunds, bounded pages and tenant/student scope',{skip:!process.env.BILLING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.BILLING_TEST_DATABASE_URL}),tx=await pool.connect(),businessId=randomUUID(),tenant={...ctx,businessId},first=randomUUID(),sibling=randomUUID(),other=randomUUID();
 try{
  const role=(await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);await tx.query('BEGIN');
  const db={withTenant:async<T>(id:string,work:(tx:PoolClient)=>Promise<T>)=>{await tx.query('SAVEPOINT student_finance_test');try{await tx.query("SELECT set_config('app.business_id',$1,true)",[id]);const result=await work(tx);await tx.query('RELEASE SAVEPOINT student_finance_test');return result;}catch(error){await tx.query('ROLLBACK TO SAVEPOINT student_finance_test');await tx.query('RELEASE SAVEPOINT student_finance_test');throw error;}}} as unknown as Database;
  const service=new StudentFinanceService(db,{subscribe(){}} as unknown as EventBus),history=new HistoryService(db);
  const source=await history.manualInvoice(tenant,{date:'2026-09-01',studentName:'Family evidence',amountMinor:1000,currency:'EUR',status:'pending',invoiceNumber:'FAMILY'},'source');
  assert.equal((await service.finance(tenant,{studentId:first})).total,0);
  const published=await db.withTenant(businessId,conn=>publishDecision(conn,tenant,{source:{kind:'imported',id:source.id,revision:1},choice:'new',studentIds:[first,sibling],workLinks:[],confirmed:true},{idempotencyKey:'family-publish'}));
  const bank=await db.withTenant(businessId,conn=>recordHistoricalReceipt(conn,tenant,{amountMinor:500,currency:'EUR',paidOn:'2026-09-02',reference:'synthetic-bank',reason:'Historical statement',idempotencyKey:'bank'}));
  await db.withTenant(businessId,conn=>allocateReceipt(conn,tenant,{receiptId:bank.id,invoiceId:published.invoiceId,amountMinor:500,currency:'EUR',idempotencyKey:'bank-allocation'}));
  await db.withTenant(businessId,conn=>adjustInvoice(conn,tenant,{invoiceId:published.invoiceId,receiptId:bank.id,kind:'refund',amountMinor:200,currency:'EUR',reason:'Recorded bank refund',occurredOn:'2026-09-03',idempotencyKey:'refund'}));
  await db.withTenant(businessId,conn=>adjustInvoice(conn,tenant,{invoiceId:published.invoiceId,kind:'credit',amountMinor:200,currency:'EUR',reason:'Recorded credit',occurredOn:'2026-09-03',idempotencyKey:'credit'}));
  const paymentId=randomUUID();await db.withTenant(businessId,conn=>importConfirmedReceipts(conn,businessId,[{paymentId,invoiceId:randomUUID(),connectionId:randomUUID(),provider:'stripe',providerReference:'synthetic-provider',amountMinor:300,currency:'EUR',confirmedAt:'2026-09-04T00:00:00.000Z',simulated:false}]));
  const providerReceipt=(await db.withTenant(businessId,conn=>conn.query('SELECT id FROM reconciliation_receipts WHERE payment_id=$1',[paymentId]))).rows[0].id;
  await db.withTenant(businessId,conn=>allocateReceipt(conn,tenant,{receiptId:providerReceipt,invoiceId:published.invoiceId,amountMinor:300,currency:'EUR',idempotencyKey:'provider-allocation'}));
  const sourceGbp=await history.manualInvoice(tenant,{date:'2026-08-01',studentName:'Separate GBP',amountMinor:2000,currency:'GBP',status:'pending'},'gbp-source');await db.withTenant(businessId,conn=>publishDecision(conn,tenant,{source:{kind:'imported',id:sourceGbp.id,revision:1},choice:'new',studentIds:[first],workLinks:[],confirmed:true},{idempotencyKey:'gbp-publish'}));
  const result=await service.finance(tenant,{studentId:first,limit:1});assert.equal(result.total,2);assert.equal(result.items.length,1);assert.equal(result.items[0]!.id,published.invoiceId);assert.equal(result.items[0]!.sharedFamilyInvoice,true);assert.equal(result.items[0]!.beneficiaryCount,2);assert.equal(result.paymentTotal,2);assert.equal(result.payments.length,1);
  const eur=result.totals.find(row=>row.currency==='EUR')!;assert.equal(eur.billedMinor,800);assert.equal(eur.recordedPaidMinor,600);assert.equal(eur.collectedMinor,300);assert.equal(eur.historicalPaidMinor,300);assert.equal(eur.refundMinor,200);assert.equal(eur.creditMinor,200);assert.equal(eur.outstandingMinor,0);assert.equal(eur.sharedInvoices,1);
  assert.equal(result.totals.find(row=>row.currency==='GBP')!.outstandingMinor,2000);assert.equal((await service.finance(tenant,{studentId:first,offset:1,limit:1})).items[0]!.currency,'GBP');
  const siblingResult=await service.finance({...tenant,role:'tutor',accessScope:'students',studentIds:[sibling]},{studentId:sibling});assert.deepEqual(siblingResult.totals[0],eur);assert.equal(siblingResult.total,1);
  assert.equal((await service.finance(tenant,{studentId:other})).total,0);assert.equal((await service.finance({...tenant,businessId:randomUUID()},{studentId:first})).total,0);
  const old=randomUUID();await db.withTenant(businessId,conn=>conn.query('INSERT INTO billing_student_aliases(business_id,source_id,target_id) VALUES($1,$2,$3)',[businessId,old,first]));assert.equal((await service.finance(tenant,{studentId:old})).total,2);
  await assert.rejects(service.finance({...tenant,role:'tutor',accessScope:'students',studentIds:[old]},{studentId:old}),/Student access is not granted/);
  // Multiple allocations to the same invoice are one payment evidence row.
  const splitSource=await history.manualInvoice(tenant,{date:'2026-09-10',studentName:'Split student',amountMinor:100,currency:'USD',status:'pending'},'split-source');
  const splitInvoice=await db.withTenant(businessId,conn=>publishDecision(conn,tenant,{source:{kind:'imported',id:splitSource.id,revision:1},choice:'new',studentIds:[other],workLinks:[],confirmed:true},{idempotencyKey:'split-publish'}));
  const splitReceipt=await db.withTenant(businessId,conn=>recordHistoricalReceipt(conn,tenant,{amountMinor:50,currency:'USD',paidOn:'2026-09-11',reference:'split-bank',reason:'Split evidence',idempotencyKey:'split-bank'}));
  for(const amountMinor of [20,30])await db.withTenant(businessId,conn=>allocateReceipt(conn,tenant,{receiptId:splitReceipt.id,invoiceId:splitInvoice.invoiceId,amountMinor,currency:'USD',idempotencyKey:`split-${amountMinor}`}));
  await db.withTenant(businessId,conn=>adjustInvoice(conn,tenant,{invoiceId:splitInvoice.invoiceId,receiptId:splitReceipt.id,kind:'refund',amountMinor:10,currency:'USD',reason:'Split refund',occurredOn:'2026-09-12',idempotencyKey:'split-refund'}));
  const split=await service.finance(tenant,{studentId:other});assert.equal(split.paymentTotal,1);assert.equal(split.payments[0]!.amountMinor,50);assert.equal(split.payments[0]!.refundedMinor,10);assert.equal(split.payments[0]!.id,`${splitReceipt.id}:${splitInvoice.invoiceId}`);assert.equal(split.totals[0]!.recordedPaidMinor,40);
  // Paid work and a paid imported alias are overlapping claims for one native debt.
  const nativeId=randomUUID();await db.withTenant(businessId,conn=>conn.query("INSERT INTO invoices(business_id,id,client_id,payer_name,currency,items,total_minor,status,issued_at) VALUES($1,$2,$3,'Paid work','CAD','[]',500,'issued',now())",[businessId,nativeId,first]));
  const workPreview=await history.preview(tenant,{originalname:'paid-cad.csv',buffer:Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Invoice Status\n2026-09-15,Paid work,1,5,Paid')},{kind:'work',currency:'CAD'});await history.commit(tenant,{token:workPreview.token},'paid-cad-work');
  const work=(await history.workLog(tenant,{})).items.find(row=>row.currency==='CAD')!;
  const reconciliation=new ReconciliationService(db,{subscribe(){}} as unknown as EventBus),native=(await reconciliation.detail(tenant,nativeId)).invoice;
  const covered=await db.withTenant(businessId,conn=>publishDecision(conn,tenant,{source:{kind:'native',id:nativeId,revision:1},choice:'existing',invoiceId:nativeId,invoiceRevision:native.revision,studentIds:[],workLinks:[{workId:work.id,revision:work.revision,amountMinor:500}],confirmed:true},{idempotencyKey:'native-paid-coverage'}));
  const paidAlias=await history.manualInvoice(tenant,{date:'2026-09-15',studentName:'Paid alias',amountMinor:500,currency:'CAD',status:'paid'},'paid-alias-source');
  await db.withTenant(businessId,conn=>publishDecision(conn,tenant,{source:{kind:'imported',id:paidAlias.id,revision:1},choice:'existing',invoiceId:nativeId,invoiceRevision:covered.guards.invoiceRevision,studentIds:[],workLinks:[],confirmed:true},{idempotencyKey:'paid-alias-publish'}));
  const detail=await reconciliation.detail(tenant,nativeId);assert.equal(detail.invoice.recordedPaidMinor,500);assert.equal(detail.invoice.outstandingMinor,0);assert.equal(detail.invoice.verifiedMinor,0);
  const cad=(await service.finance(tenant,{studentId:first})).totals.find(row=>row.currency==='CAD')!;assert.equal(cad.recordedPaidMinor,500);assert.equal(cad.historicalPaidMinor,500);assert.equal(cad.collectedMinor,0);assert.equal(cad.outstandingMinor,0);

 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
});
