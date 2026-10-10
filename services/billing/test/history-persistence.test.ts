import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { HistoryService } from '../src/history.js';
import { HistoryAnalyticsService } from '../src/history-analytics.js';
const normalized=(v:unknown)=>JSON.parse(JSON.stringify(v));

test('Sources/raw bytes, tenant isolation, partial review, retries, edits and exact financial aggregates', {skip:!process.env.BILLING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.BILLING_TEST_DATABASE_URL}),tx=await pool.connect();
 try {
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const role=(await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  if(!(await tx.query("SELECT to_regclass('billing_history_sources') present")).rows[0].present)await tx.query(await readFile(new URL('../migrations/007_business_history.sql',import.meta.url),'utf8'));
  async function tenant<T>(businessId:string,work:(tx:PoolClient)=>Promise<T>){await tx.query('SAVEPOINT history_test');try{await tx.query("SELECT set_config('app.business_id',$1,true)",[businessId]);const snapshotTx=new Proxy(tx,{get(target,key){if(key==='query')return (sql:string,...args:any[])=>sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'?Promise.resolve({rows:[]}):(target.query as any).call(target,sql,...args);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});const result=await work(snapshotTx);await tx.query('RELEASE SAVEPOINT history_test');return result;}catch(error){await tx.query('ROLLBACK TO SAVEPOINT history_test');await tx.query('RELEASE SAVEPOINT history_test');throw error;}}
  const db={withTenant:tenant} as unknown as Database,service=new HistoryService(db),analytics=new HistoryAnalyticsService(db);
  const ctx:RequestContext={sub:'opaque_BetterAuth_user_123abc',businessId:randomUUID(),role:'owner',entitlements:['billing'],requestId:randomUUID()},other={...ctx,businessId:randomUUID()};
  const bytes=Buffer.from('Date,Student Name,Hours Worked,Hourly Rate (€),Total (€),Invoice Status,Extra\n2026-09-01,Synthetic A,1.5,40,60,Paid,original\n2026-09-02,Synthetic A,0.25,15,,Sent,unknown retained\n2026-08-02,Synthetic B,1,15,15,Pending,previous\n2026-09-03,Synthetic C,1,15,15,,review');
  const preview=await service.preview(ctx,{originalname:'source.csv',buffer:bytes},{kind:'work'});assert.deepEqual(preview.summary,{valid:3,invalid:1,skipped:0});
  assert.equal((await service.preview(ctx,{originalname:'renamed.csv',buffer:bytes},{kind:'work'})).token,preview.token);
  await assert.rejects(()=>service.commit(other,{token:preview.token,allowPartial:true},'other'),/history_stage_not_found/);
  await assert.rejects(()=>service.commit(ctx,{token:preview.token},'before-review'),/Review row errors/);
  const committed=await service.commit(ctx,{token:preview.token,allowPartial:true},'commit');assert.equal(committed.imported,3);assert.equal(committed.partial,true);
  for(const key of ['commit','new-key'])assert.deepEqual(normalized(await service.commit(ctx,{token:preview.token,allowPartial:true},key)),normalized(committed));
  await assert.rejects(()=>service.commit(ctx,{token:preview.token},'commit'),/idempotency_key_payload_mismatch/);
  assert.deepEqual((await service.download(ctx,preview.importId)).file_bytes,bytes);await assert.rejects(()=>service.download(other,preview.importId),/history_source_not_found/);
  const work=await service.workLog(ctx,{month:'2026-09',status:'unpaid',limit:'1'});assert.equal(work.total,1);assert.equal(work.items[0]!.rawColumns.Extra,'unknown retained');assert.equal((await service.workLog(other,{})).total,0);
  assert.equal((await service.workSummary(ctx,{})).currencies[0]!.totalMinor,7875);
  const changed=await service.editWork(ctx,work.items[0]!.id,{hours:0.5,countAsClasses:true,status:'paid',paidDate:'2026-09-06',revision:1});assert.equal(changed.amountMinor,750);
  await assert.rejects(()=>service.editWork(ctx,changed.id,{status:'pending',revision:1}),/revision_conflict/);await assert.rejects(()=>service.editWork(other,changed.id,{status:'pending'}),/work_log_not_found/);
  const archive=await service.preview(ctx,{originalname:'invoice.pdf',buffer:Buffer.from('%PDF-1.7\nSynthetic')},{kind:'archive'});assert.equal((await service.commit(ctx,{token:archive.token},'archive')).imported,0);
  const historical=await service.manualInvoice(ctx,{date:'2026-09-01',studentName:'Synthetic A',amountMinor:6000,currency:'EUR',status:'paid',paidDate:'2026-09-05',invoiceNumber:'SYNTH-1',importId:archive.importId},'manual');assert.equal(historical.paymentEvidence,'historical_declaration');
  await assert.rejects(()=>service.manualInvoice(ctx,{date:'2026-09-01',studentName:'Synthetic A',amountMinor:6000,currency:'EUR',status:'paid',invoiceNumber:'synth-1'},'duplicate'),/invoice_number_already/);
  await service.manualInvoice(ctx,{date:'2026-09-02',studentName:'Synthetic GBP',amountMinor:9000,currency:'GBP',status:'pending',invoiceNumber:'SYNTH-2'},'manual-gbp');
  const nativeId=randomUUID();await tenant(ctx.businessId,async conn=>{
   await conn.query(`INSERT INTO invoices(id,business_id,payer_name,currency,items,total_minor,paid_minor,status,issued_at,service_month) VALUES($1,$2,'Synthetic native','EUR','[]',10000,10000,'settled',now(),'2026-09-01')`,[nativeId,ctx.businessId]);
   await conn.query(`INSERT INTO payment_allocations(business_id,payment_id,invoice_id,amount_minor,currency,provider,simulated) VALUES($1,$2,$3,3000,'EUR','stripe',false),($1,$4,$3,7000,'EUR','sandbox',true)`,[ctx.businessId,randomUUID(),nativeId,randomUUID()]);
  });
  const invoices=await service.invoiceHistory(ctx,{month:'2026-09'});assert.equal(invoices.total,3);assert.equal(invoices.items.find(i=>i.id===nativeId)!.origin,'native');assert.equal(invoices.items.find(i=>i.id===nativeId)!.paidMinor,3000);assert.equal(invoices.items.find(i=>i.id===nativeId)!.simulatedMinor,7000);await assert.rejects(()=>service.editInvoice(ctx,nativeId,{status:'pending'}),/native invoices are immutable/);
  await assert.rejects(()=>service.manualInvoice(ctx,{date:'2026-09-01',studentName:'Synthetic native',amountMinor:10000,currency:'EUR',status:'paid',invoiceNumber:nativeId},'native-duplicate'),/invoice_number_already/);
  const invoiceBytes=Buffer.from('Date,Student Name,Amount,Currency,Invoice Status,Invoice Number\n2026-09-01,Synthetic A,60,EUR,Paid,SYNTH-1\n2026-09-03,Synthetic USD,40,USD,Paid,SYNTH-3');
  const invoicePreview=await service.preview(ctx,{originalname:'invoices.csv',buffer:invoiceBytes},{kind:'invoices'});assert.deepEqual(invoicePreview.summary,{valid:1,invalid:1,skipped:0});
  assert.equal((await service.commit(ctx,{token:invoicePreview.token,allowPartial:true},'invoice-import')).imported,1);
  const result=await analytics.analytics(ctx,{month:'2026-09'}),eur=result.currencies.find(c=>c.currency==='EUR')!,gbp=result.currencies.find(c=>c.currency==='GBP')!;
  assert.equal(eur.verifiedCollectedMinor,3000);assert.equal(eur.historicalPaidMinor,6000);assert.equal(eur.totalRecordedRevenueMinor,9000);assert.equal(eur.pendingMinor,7000);assert.equal(eur.ledgerTotalMinor,8250);assert.equal(eur.expectedThisMonthMinor,6750);assert.equal(gbp.pendingMinor,9000);assert.equal(gbp.ledgerTotalMinor,null);assert.equal(result.engagement.monthHours,2);assert.equal(result.engagement.averageClassFrequency,null);assert.equal(result.engagement.churnRate,null);assert.equal(result.students.tracked,null);assert.ok(result.trend.every(row=>row.activeStudents===null));
  const remapped=await service.preview(ctx,{originalname:'source.csv',buffer:bytes},{kind:'work',countAsClasses:true});
  await assert.rejects(()=>service.commit(ctx,{token:remapped.token,allowPartial:true},'remapped'),/source_already_imported_with_other_options/);
  const empty=await analytics.analytics(other,{month:'2026-09'});assert.equal(empty.engagement.totalHours,null);assert.equal(empty.students.tracked,null);assert.deepEqual(empty.currencies,[]);
  const nativeCtx={...ctx,businessId:randomUUID()},studentId=randomUUID();
  await tenant(nativeCtx.businessId,async conn=>{
    await conn.query("INSERT INTO billing_settings(business_id,time_zone) VALUES($1,'Africa/Casablanca')",[nativeCtx.businessId]);
    await conn.query("INSERT INTO student_rates(business_id,id,client_id,payer_name,currency,unit_price_minor) VALUES($1,$2,$3,'Synthetic','EUR',2500)",[nativeCtx.businessId,randomUUID(),studentId]);
    await conn.query("INSERT INTO billing_classes(business_id,class_id,source,client_id,title,starts_at,ends_at,status,revision) VALUES($1,$2,'internal',$3,'Synthetic','2026-08-31T23:30:00Z','2026-09-01T00:30:00Z','completed',1)",[nativeCtx.businessId,randomUUID(),studentId]);
  });
  const nativeOnly=await analytics.analytics(nativeCtx,{month:'2026-09'});assert.equal(nativeOnly.students.activeThisMonth,1);assert.equal(nativeOnly.engagement.monthHours,1);assert.equal(nativeOnly.engagement.averageClassFrequency,1);assert.equal(nativeOnly.currencies[0]!.nativeExpectedMinor,2500);assert.equal(nativeOnly.currencies[0]!.expectedThisMonthMinor,null);assert.equal(nativeOnly.trend[0]!.month,'2026-09');
  await tenant(nativeCtx.businessId,conn=>conn.query("INSERT INTO billing_classes(business_id,class_id,source,title,starts_at,ends_at,status,revision) VALUES($1,$2,'internal','Synthetic unlinked','2026-09-02T10:00:00Z','2026-09-02T11:00:00Z','completed',1)",[nativeCtx.businessId,randomUUID()]));
  const unlinked=await analytics.analytics(nativeCtx,{month:'2026-09'});assert.equal(unlinked.students.tracked,null);assert.equal(unlinked.engagement.monthHours,2);assert.equal(unlinked.engagement.averageCommitmentHours,null);assert.equal(unlinked.trend[0]!.activeStudents,null);
  await tenant(ctx.businessId,async conn=>{const raw=(await conn.query('SELECT raw_source,preview,staged_by FROM billing_history_sources WHERE id=$1',[preview.importId])).rows[0];assert.equal(raw.staged_by,ctx.sub);assert.equal(raw.preview.summary.invalid,1);assert.equal(raw.raw_source.sheets[0].rows[4].columns.Extra,'review');assert.equal((await conn.query('SELECT count(*) n FROM payment_allocations')).rows[0].n,'2');});
 } finally {await tx.query('ROLLBACK');tx.release();await pool.end();}
});
