import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { Pool,type PoolClient } from 'pg';
import type { ConfirmedReceipt,ReconciliationDecision,RequestContext } from '@palladium/contracts';
import { ensureReconciliation,reconciliationNeedsProjection,importConfirmedReceipts,publishDecision,previewDecision,reconciliationTotals,reconciliationInvoiceBalances,recordHistoricalReceipt,allocateReceipt,adjustInvoice,reconciliationMinor } from '../src/reconciliation-engine.js';

test('canonical reconciliation on ordinary local PostgreSQL, fresh isolated schema', {skip:!process.env.BILLING_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.BILLING_TEST_DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Engine tests only use local PostgreSQL');
  const schema=`reconciliation_test_${randomUUID().replaceAll('-','')}`,pool=new Pool({connectionString:url.toString(),options:`-c search_path=${schema},public`});
  await pool.query(`CREATE SCHEMA ${schema}`);
  try {
    const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
    const dir=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file,dir),'utf8'));
    await pool.query('CREATE TABLE service_outbox(id uuid PRIMARY KEY,event jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz)');
    const ctx=():RequestContext=>({sub:'synthetic_staff',businessId:randomUUID(),requestId:randomUUID(),role:'owner',entitlements:['billing']});
    async function run<T>(context:RequestContext,work:(tx:PoolClient)=>Promise<T>){const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query("SELECT set_config('app.business_id',$1,true)",[context.businessId]);const result=await work(tx);await tx.query('COMMIT');return result;}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}}
    async function source(tx:PoolClient,c:RequestContext){const id=randomUUID();await tx.query(`INSERT INTO billing_history_sources(business_id,id,token,content_hash,options_hash,file_name,content_type,file_bytes,options,raw_source,preview,kind,staged_by)
      VALUES($1,$2,$3,$4,'synthetic','synthetic.csv','text/csv',$5,'{}','{}','{}','work','synthetic_staff')`,[c.businessId,id,randomUUID(),randomUUID(),Buffer.from('synthetic')]);return id;}
    async function work(tx:PoolClient,c:RequestContext,amount:number,status='paid',ccy='EUR'){const id=randomUUID(),importId=await source(tx,c);await tx.query(`INSERT INTO billing_work_log(business_id,id,import_id,source_row,work_date,student_name,hours,rate_minor,amount_minor,currency,status,raw_columns)
      VALUES($1,$2,$3,1,'2026-09-01','Synthetic work',1,$4,$4,$5,$6,'{}')`,[c.businessId,id,importId,amount,ccy,status]);return id;}
    async function imported(tx:PoolClient,c:RequestContext,amount:number,status='paid',ccy='EUR'){const id=randomUUID();await tx.query(`INSERT INTO billing_invoice_history(business_id,id,invoice_date,student_name,amount_minor,currency,status,invoice_number)
      VALUES($1,$2,'2026-10-01','Synthetic student',$3,$4,$5,'SYNTHETIC-DUPLICATE')`,[c.businessId,id,amount,ccy,status]);return id;}
    async function native(tx:PoolClient,c:RequestContext,amount:number,ccy='EUR',draft=false,paid=0){const id=randomUUID();await tx.query(`INSERT INTO invoices(business_id,id,payer_name,currency,items,total_minor,status,issued_at,paid_minor)
      VALUES($1,$2,'Synthetic payer',$3,'[]',$4,$5,$6,$7)`,[c.businessId,id,ccy,amount,draft?'draft':paid===amount?'settled':'issued',draft?null:'2026-10-01T00:00:00Z',paid]);return id;}
    const decision=(id:string,links:ReconciliationDecision['workLinks']=[],students:string[]=[]):ReconciliationDecision=>({source:{kind:'imported',id,revision:1},choice:'new',confirmed:true,studentIds:students,workLinks:links});
    const receipt=(amount:number,ccy='EUR'):ConfirmedReceipt=>({paymentId:randomUUID(),invoiceId:randomUUID(),connectionId:randomUUID(),provider:'stripe',providerReference:randomUUID(),amountMinor:amount,currency:ccy,confirmedAt:'2026-10-02T00:00:00Z',simulated:false});
    const totals=(c:RequestContext)=>run(c,tx=>reconciliationTotals(tx,c.businessId));

    await t.test('paid work is replaced by invoice evidence; aliases, previews and stale coverage conserve settlement',async()=>{
      const c=ctx(),studentA=randomUUID(),studentB=randomUUID();let w='',s='';
      await run(c,async tx=>{w=await work(tx,c,50000);s=await imported(tx,c,50000);});
      assert.equal((await totals(c))[0]!.recordedPaidMinor,50000);assert.equal((await totals(c))[0]!.unresolvedInvoices,1);
      const d=decision(s,[{workId:w,revision:1,amountMinor:50000}],[studentA,studentB]);
      const preview=await run(c,tx=>previewDecision(tx,c,d));assert.equal(preview.after[0]!.recordedPaidMinor,50000);
      await run(c,async tx=>{assert.equal((await tx.query('SELECT count(*) n FROM reconciliation_invoices')).rows[0].n,'0');assert.equal((await tx.query('SELECT count(*) n FROM reconciliation_audit')).rows[0].n,'0');});
      const accepted=await run(c,tx=>publishDecision(tx,c,d,{idempotencyKey:'first'}));assert.deepEqual(await run(c,tx=>publishDecision(tx,c,d,{idempotencyKey:'first'})),accepted);
      assert.deepEqual(await run(c,tx=>publishDecision(tx,c,d,{idempotencyKey:'independent-duplicate-delivery'})),accepted);
      assert.equal(accepted.after[0]!.recordedPaidMinor,50000);assert.equal(accepted.after[0]!.invoicedMinor,50000);
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...d,studentIds:[studentA]},{idempotencyKey:'first'})),/idempotency_key_payload_mismatch/);
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...d,studentIds:[studentA]},{idempotencyKey:'unguarded'})),/requires_invoice_revision/);
      const s2=await run(c,tx=>imported(tx,c,50000));
      const payer=randomUUID(),linked=await run(c,tx=>publishDecision(tx,c,{...decision(s2),choice:'existing',invoiceId:accepted.invoiceId,invoiceRevision:accepted.guards.invoiceRevision,payerId:payer,dueDate:'2026-10-15',serviceMonth:'2026-09'},{idempotencyKey:'alias'}));
      assert.equal(linked.after[0]!.recordedPaidMinor,50000);assert.equal(linked.after[0]!.invoicedMinor,50000);
      await run(c,async tx=>{const row=(await tx.query('SELECT payer_id,due_date::text,service_month::text FROM reconciliation_invoices WHERE id=$1',[accepted.invoiceId])).rows[0];assert.equal(row.payer_id,payer);assert.equal(row.due_date,'2026-10-15');assert.equal(row.service_month,'2026-09-01');});
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...decision(s2),choice:'existing',invoiceId:accepted.invoiceId,invoiceRevision:linked.guards.invoiceRevision,payerId:randomUUID()},{idempotencyKey:'payer-conflict'})),/reviewed_metadata_conflict/);
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...decision(s2),choice:'existing',invoiceId:accepted.invoiceId,invoiceRevision:linked.guards.invoiceRevision,dueDate:'2026-10-16'},{idempotencyKey:'due-conflict'})),/reviewed_metadata_conflict/);
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...decision(s2),choice:'existing',invoiceId:accepted.invoiceId,invoiceRevision:linked.guards.invoiceRevision,serviceMonth:'2026-10'},{idempotencyKey:'month-conflict'})),/reviewed_metadata_conflict/);
      assert.equal((await run(c,tx=>reconciliationInvoiceBalances(tx,c.businessId,studentA))).length,1);
      assert.equal((await run(c,tx=>reconciliationInvoiceBalances(tx,c.businessId,randomUUID()))).length,0);
      await run(c,async tx=>{await tx.query('UPDATE billing_work_log SET amount_minor=100000,status=\'pending\',revision=2 WHERE id=$1',[w]);await tx.query('UPDATE billing_invoice_history SET amount_minor=100000,revision=2 WHERE id=$1',[s2]);});
      const stale=(await totals(c))[0]!;assert.equal(stale.recordedPaidMinor,50000);assert.equal(stale.pendingMinor,0);assert.equal(stale.workValueMinor,100000);assert.equal(stale.staleWorkLinks,1);assert.equal(stale.staleSources,1);
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...d,choice:'existing',invoiceId:accepted.invoiceId,invoiceRevision:linked.guards.invoiceRevision},{idempotencyKey:'stale-work'})),/work_revision_conflict/);
      const corrected=await run(c,tx=>publishDecision(tx,c,{...d,choice:'existing',invoiceId:accepted.invoiceId,invoiceRevision:linked.guards.invoiceRevision,workLinks:[{workId:w,revision:2,amountMinor:50000}]},{idempotencyKey:'review-correction'}));
      assert.equal(corrected.after[0]!.staleWorkLinks,0);assert.equal(corrected.after[0]!.pendingMinor,50000);
    });

    await t.test('partial work, separate currencies, drafts, zero imported amounts, exact integer boundaries',async()=>{
      const c=ctx();await run(c,async tx=>{const w=await work(tx,c,50000,'pending'),s=await imported(tx,c,20000,'pending');await publishDecision(tx,c,decision(s,[{workId:w,revision:1,amountMinor:20000}]),{idempotencyKey:'partial'});
        await work(tx,c,40000,'unsent','GBP');await native(tx,c,10000,'EUR',true);await ensureReconciliation(tx,c.businessId);
        await imported(tx,c,0,'pending','USD');});
      const rows=await totals(c),eur=rows.find(row=>row.currency==='EUR')!,gbp=rows.find(row=>row.currency==='GBP')!;
      assert.equal(eur.pendingMinor,50000);assert.equal(eur.unsentMinor,10000);assert.equal(eur.outstandingMinor,20000);assert.equal(eur.invoicedMinor,20000);assert.equal(gbp.unsentMinor,40000);
      assert.equal(rows.find(row=>row.currency==='USD')!.unresolvedInvoices,1);
      assert.equal(reconciliationMinor('9007199254740991'),Number.MAX_SAFE_INTEGER);assert.throws(()=>reconciliationMinor('9007199254740992'),/numeric_range/);assert.throws(()=>reconciliationMinor(1.5),/numeric_range/);
      const overflow=ctx();await run(overflow,async tx=>{await work(tx,overflow,Number.MAX_SAFE_INTEGER);await work(tx,overflow,1);});await assert.rejects(()=>totals(overflow),/numeric_range/);
    });

    await t.test('shared work revision refreshes every invoice atomically; cap and currency failures remain quarantined',async()=>{
      const c=ctx();let w='',sourceA='',a='',b='',revisionA=0;
      await run(c,async tx=>{w=await work(tx,c,10000);sourceA=await imported(tx,c,5000,'pending');
        const first=await publishDecision(tx,c,decision(sourceA,[{workId:w,revision:1,amountMinor:5000}]),{idempotencyKey:'first'});a=first.invoiceId;revisionA=first.guards.invoiceRevision;
        b=(await publishDecision(tx,c,decision(await imported(tx,c,5000,'pending'),[{workId:w,revision:1,amountMinor:5000}]),{idempotencyKey:'second'})).invoiceId;
        await tx.query('UPDATE billing_work_log SET revision=2 WHERE id=$1',[w]);});
      assert.equal((await totals(c))[0]!.recordedPaidMinor,10000);assert.equal((await totals(c))[0]!.staleWorkLinks,2);
      const review:ReconciliationDecision={...decision(sourceA,[{workId:w,revision:2,amountMinor:5000}]),choice:'existing',invoiceId:a,invoiceRevision:revisionA};
      const preview=await run(c,tx=>previewDecision(tx,c,review));assert.deepEqual(preview.affectedInvoices.map(item=>item.invoiceId).sort(),[a,b].sort());assert.equal(preview.after[0]!.staleWorkLinks,0);
      assert.deepEqual(preview.guards.invoices,[{invoiceId:b,revision:2}]);
      assert.equal((await totals(c))[0]!.staleWorkLinks,2,'preview does not publish the shared snapshot refresh');
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,review,{idempotencyKey:'missing-guards'})),/affected_invoice_guards_conflict/);
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...review,invoiceGuards:[...preview.guards.invoices,{invoiceId:a,revision:revisionA}]},{idempotencyKey:'extra-guard'})),/affected_invoice_guards_conflict/);
      const refreshed=await run(c,tx=>publishDecision(tx,c,{...review,invoiceGuards:preview.guards.invoices},{idempotencyKey:'refresh'}));assert.equal(refreshed.after[0]!.staleWorkLinks,0);assert.equal(refreshed.after[0]!.recordedPaidMinor,10000);
      assert.ok(refreshed.affectedInvoices.every(item=>item.revision===3 && item.workIds[0]===w));
      await assert.rejects(()=>run(c,tx=>tx.query('UPDATE reconciliation_work_coverage SET work_revision=3 WHERE invoice_id=$1 AND work_id=$2',[a,w])),/work_snapshot_conflict/);
      await run(c,tx=>tx.query('UPDATE billing_work_log SET amount_minor=8000,revision=3 WHERE id=$1',[w]));
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...review,invoiceRevision:refreshed.guards.invoiceRevision,workLinks:[{workId:w,revision:3,amountMinor:5000}]},{idempotencyKey:'too-low'})),/coverage_exceeds_value/);
      assert.equal((await totals(c))[0]!.recordedPaidMinor,10000);assert.equal((await totals(c))[0]!.staleWorkLinks,2);
      await run(c,tx=>tx.query("UPDATE billing_work_log SET amount_minor=10000,currency='GBP',revision=4 WHERE id=$1",[w]));
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...review,invoiceRevision:refreshed.guards.invoiceRevision,workLinks:[{workId:w,revision:4,amountMinor:5000}]},{idempotencyKey:'wrong-currency'})),/currency_mismatch/);
      const quarantined=(await totals(c)).find(row=>row.currency==='EUR')!;assert.equal(quarantined.recordedPaidMinor,10000);assert.equal(quarantined.staleWorkLinks,2);
      await run(c,async tx=>{const rows=(await tx.query('SELECT work_revision,work_amount_minor,currency FROM reconciliation_work_coverage WHERE work_id=$1',[w])).rows;assert.ok(rows.every(row=>row.work_revision===2 && row.work_amount_minor==='10000' && row.currency==='EUR'));});
    });

    await t.test('another affected invoice changing after preview rejects publication; new targets exclude ephemeral preview IDs',async()=>{
      const c=ctx();let w='',sourceA='',a='',b='';await run(c,async tx=>{w=await work(tx,c,10000);sourceA=await imported(tx,c,5000,'pending');a=(await publishDecision(tx,c,decision(sourceA,[{workId:w,revision:1,amountMinor:5000}]),{idempotencyKey:'a'})).invoiceId;b=(await publishDecision(tx,c,decision(await imported(tx,c,5000,'pending'),[{workId:w,revision:1,amountMinor:5000}]),{idempotencyKey:'b'})).invoiceId;await tx.query('UPDATE billing_work_log SET revision=2 WHERE id=$1',[w]);});
      const input:ReconciliationDecision={...decision(sourceA,[{workId:w,revision:2,amountMinor:5000}]),choice:'existing',invoiceId:a,invoiceRevision:2};
      const oldPreview=await run(c,tx=>previewDecision(tx,c,input));assert.deepEqual(oldPreview.guards.invoices,[{invoiceId:b,revision:2}]);
      const p=receipt(1000);await run(c,async tx=>{await importConfirmedReceipts(tx,c.businessId,[p]);const receiptId=(await tx.query('SELECT id FROM reconciliation_receipts WHERE payment_id=$1',[p.paymentId])).rows[0].id;await allocateReceipt(tx,c,{invoiceId:b,receiptId,currency:'EUR',amountMinor:1000,idempotencyKey:'other-invoice-allocation'});});
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{...input,invoiceGuards:oldPreview.guards.invoices},{idempotencyKey:'stale-other-invoice'})),/affected_invoice_revision_conflict/);
      await run(c,async tx=>{assert.equal((await tx.query('SELECT revision FROM reconciliation_invoices WHERE id=$1',[a])).rows[0].revision,2);assert.equal((await tx.query('SELECT count(*) n FROM reconciliation_work_coverage WHERE work_revision=1 AND work_id=$1',[w])).rows[0].n,'2');});
      const currentPreview=await run(c,tx=>previewDecision(tx,c,input));assert.deepEqual(currentPreview.guards.invoices,[{invoiceId:b,revision:3}]);
      const result=await run(c,tx=>publishDecision(tx,c,{...input,invoiceGuards:currentPreview.guards.invoices},{idempotencyKey:'guarded-refresh'}));assert.equal(result.after[0]!.staleWorkLinks,0);assert.equal(result.affectedInvoices.find(item=>item.invoiceId===a)!.revision,3);assert.equal(result.affectedInvoices.find(item=>item.invoiceId===b)!.revision,4);
      const fresh=ctx();let freshWork='',first='',newSource='';await run(fresh,async tx=>{freshWork=await work(tx,fresh,10000);first=(await publishDecision(tx,fresh,decision(await imported(tx,fresh,5000,'pending'),[{workId:freshWork,revision:1,amountMinor:5000}]),{idempotencyKey:'first'})).invoiceId;newSource=await imported(tx,fresh,5000,'pending');await tx.query('UPDATE billing_work_log SET revision=2 WHERE id=$1',[freshWork]);});
      const newDecision=decision(newSource,[{workId:freshWork,revision:2,amountMinor:5000}]),newPreview=await run(fresh,tx=>previewDecision(tx,fresh,newDecision));
      assert.deepEqual(newPreview.guards.invoices,[{invoiceId:first,revision:2}]);assert.ok(newPreview.guards.invoices.every(guard=>guard.invoiceId!==newPreview.invoiceId));
      const newPublished=await run(fresh,tx=>publishDecision(tx,fresh,{...newDecision,invoiceGuards:newPreview.guards.invoices},{idempotencyKey:'new-guarded'}));assert.notEqual(newPublished.invoiceId,newPreview.invoiceId);assert.equal(newPublished.after[0]!.staleWorkLinks,0);
    });

    await t.test('reviewed paid work and paid imported aliases support unpaid invoices using one overlapping claim floor',async()=>{
      const c=ctx();let w='',n='',s='';await run(c,async tx=>{w=await work(tx,c,50000);n=await native(tx,c,50000);s=await imported(tx,c,50000);await ensureReconciliation(tx,c.businessId);});
      assert.equal((await totals(c))[0]!.recordedPaidMinor,50000);
      const accepted=await run(c,tx=>publishDecision(tx,c,{...decision(s,[{workId:w,revision:1,amountMinor:50000}]),choice:'existing',invoiceId:n,invoiceRevision:1},{idempotencyKey:'native-paid-alias'}));
      assert.equal(accepted.after[0]!.recordedPaidMinor,50000);assert.equal(accepted.after[0]!.pendingMinor,0);assert.equal(accepted.after[0]!.verifiedReceivedMinor,0);
      const balances=await run(c,tx=>reconciliationInvoiceBalances(tx,c.businessId));assert.equal(balances[0]!.recorded_paid_minor,50000);assert.equal(balances[0]!.balance_minor,0);assert.equal(balances[0]!.status,'issued');
      const credited=await run(c,tx=>adjustInvoice(tx,c,{invoiceId:n,kind:'credit',amountMinor:10000,currency:'EUR',reason:'Synthetic explicit credit',occurredOn:'2026-10-03',idempotencyKey:'claim-credit'}));assert.equal(credited.after[0]!.invoicedMinor,40000);assert.equal(credited.after[0]!.recordedPaidMinor,50000);assert.equal(credited.after[0]!.pendingMinor,0);
      const p={...receipt(40000),invoiceId:n};await run(c,tx=>importConfirmedReceipts(tx,c.businessId,[p]));assert.equal((await totals(c))[0]!.recordedPaidMinor,50000,'receipt confirms the claim; it is never added');
      const rid=await run(c,async tx=>(await tx.query('SELECT id FROM reconciliation_receipts WHERE payment_id=$1',[p.paymentId])).rows[0].id);
      const refunded=await run(c,tx=>adjustInvoice(tx,c,{invoiceId:n,receiptId:rid,kind:'refund',amountMinor:10000,currency:'EUR',reason:'Synthetic returned amount',occurredOn:'2026-10-04',idempotencyKey:'claim-refund'}));
      assert.equal(refunded.after[0]!.recordedPaidMinor,40000);assert.equal(refunded.after[0]!.verifiedReceivedMinor,30000);assert.equal(refunded.after[0]!.historicalPaidMinor,10000);assert.equal(refunded.after[0]!.pendingMinor,0);
      const partial=ctx();await run(partial,async tx=>{const workId=await work(tx,partial,50000),sourceId=await imported(tx,partial,50000,'pending');const published=await publishDecision(tx,partial,decision(sourceId,[{workId,revision:1,amountMinor:20000}]),{idempotencyKey:'partial-paid-work'});
        assert.equal(published.after[0]!.recordedPaidMinor,50000);assert.equal(published.after[0]!.pendingMinor,30000);assert.equal((await reconciliationInvoiceBalances(tx,partial.businessId))[0]!.recorded_paid_minor,20000);});
      const pending=ctx();await run(pending,async tx=>{const workId=await work(tx,pending,50000),sourceId=await imported(tx,pending,50000,'pending');const published=await publishDecision(tx,pending,decision(sourceId,[{workId,revision:1,amountMinor:50000}]),{idempotencyKey:'all-paid-work'});assert.equal(published.after[0]!.recordedPaidMinor,50000);assert.equal(published.after[0]!.pendingMinor,0);});
    });

    await t.test('native legacy payment enrichment, duplicate provider identity, invoice mismatch, simulations',async()=>{
      const c=ctx(),p=receipt(30000);await run(c,async tx=>{p.invoiceId=await native(tx,c,100000,'EUR',false,100000);
        await tx.query(`INSERT INTO payment_allocations(business_id,payment_id,invoice_id,amount_minor,currency,provider,simulated) VALUES($1,$2,$3,30000,'EUR','stripe',false),($1,$4,$3,70000,'EUR','sandbox',true)`,[c.businessId,p.paymentId,p.invoiceId,randomUUID()]);
        assert.equal(await reconciliationNeedsProjection(tx,c.businessId),true);await ensureReconciliation(tx,c.businessId);assert.equal(await reconciliationNeedsProjection(tx,c.businessId),false);await ensureReconciliation(tx,c.businessId);});
      const initial=(await totals(c))[0]!;assert.equal(initial.verifiedReceivedMinor,30000);assert.equal(initial.recordedPaidMinor,30000);assert.equal(initial.pendingMinor,70000);
      assert.deepEqual(await run(c,tx=>importConfirmedReceipts(tx,c.businessId,[p])),{imported:0,enriched:1,unchanged:0});
      assert.deepEqual(await run(c,tx=>importConfirmedReceipts(tx,c.businessId,[p,p])),{imported:0,enriched:0,unchanged:2});
      assert.equal((await totals(c))[0]!.verifiedReceivedMinor,30000);
      await run(c,async tx=>{assert.equal((await tx.query('SELECT count(*) n FROM reconciliation_receipts')).rows[0].n,'1');assert.equal((await tx.query('SELECT count(*) n FROM reconciliation_allocations')).rows[0].n,'1');});
      await assert.rejects(()=>run(c,tx=>importConfirmedReceipts(tx,c.businessId,[{...p,amountMinor:30001}])),/identity_conflict/);
      await assert.rejects(()=>run(c,tx=>importConfirmedReceipts(tx,c.businessId,[{...p,paymentId:randomUUID()}])),/identity_conflict/);
      await assert.rejects(()=>run(c,tx=>importConfirmedReceipts(tx,c.businessId,[{...p,invoiceId:randomUUID()}])),/receipt_identity_conflict/);
      const sim={...receipt(50000),provider:'sandbox',simulated:true};await run(c,tx=>importConfirmedReceipts(tx,c.businessId,[sim]));assert.equal((await totals(c))[0]!.verifiedReceivedMinor,30000);
      const nativeAlias=await run(c,tx=>tx.query("SELECT invoice_id FROM reconciliation_source_aliases WHERE kind='native' AND source_id=$1",[p.invoiceId]));
      await assert.rejects(()=>run(c,tx=>publishDecision(tx,c,{source:{kind:'native',id:p.invoiceId,revision:1},choice:'existing',invoiceId:randomUUID(),invoiceRevision:1,studentIds:[],workLinks:[],confirmed:true},{idempotencyKey:'merge-native'})),/native_obligation_cannot_merge/);
      assert.equal(nativeAlias.rows[0].invoice_id,p.invoiceId);
      await assert.rejects(()=>run(c,tx=>tx.query('UPDATE reconciliation_receipts SET amount_minor=amount_minor+1 WHERE payment_id=$1',[p.paymentId])),/receipt_identity_immutable/);
    });

    await t.test('native revision projection preserves reviewed missing dates and prefers known native dates',async()=>{
      const c=ctx();let n='';await run(c,async tx=>{n=await native(tx,c,50000);await ensureReconciliation(tx,c.businessId);
        await publishDecision(tx,c,{source:{kind:'native',id:n,revision:1},choice:'existing',invoiceId:n,invoiceRevision:1,studentIds:[],workLinks:[],confirmed:true,dueDate:'2026-10-15',serviceMonth:'2026-09'},{idempotencyKey:'review-native-dates'});
        await tx.query('UPDATE invoices SET revision=revision+1 WHERE id=$1',[n]);await ensureReconciliation(tx,c.businessId);
        const row=(await tx.query('SELECT due_date::text,service_month::text FROM reconciliation_invoices WHERE id=$1',[n])).rows[0];assert.equal(row.due_date,'2026-10-15');assert.equal(row.service_month,'2026-09-01');
        await tx.query("UPDATE invoices SET due_at='2026-10-20T00:00:00Z',service_month='2026-10-01',revision=revision+1 WHERE id=$1",[n]);await ensureReconciliation(tx,c.businessId);
        const known=(await tx.query('SELECT due_date::text,service_month::text FROM reconciliation_invoices WHERE id=$1',[n])).rows[0];assert.equal(known.due_date,'2026-10-20');assert.equal(known.service_month,'2026-10-01');});
    });

    await t.test('split payments, historical evidence, overlapping paid declarations, credits and refunds',async()=>{
      const c=ctx(),p=receipt(100000);let invoiceA='',invoiceB='',receiptId='';
      await run(c,async tx=>{const a=await imported(tx,c,60000),b=await imported(tx,c,40000,'pending');invoiceA=(await publishDecision(tx,c,decision(a),{idempotencyKey:'a'})).invoiceId;invoiceB=(await publishDecision(tx,c,decision(b),{idempotencyKey:'b'})).invoiceId;
        await importConfirmedReceipts(tx,c.businessId,[p]);receiptId=(await tx.query('SELECT id FROM reconciliation_receipts WHERE payment_id=$1',[p.paymentId])).rows[0].id;});
      assert.equal((await totals(c))[0]!.unallocatedMinor,100000);
      const allocation={receiptId,invoiceId:invoiceA,amountMinor:60000,currency:'EUR',idempotencyKey:'allocate-a'};
      const first=await run(c,tx=>allocateReceipt(tx,c,allocation));assert.deepEqual(await run(c,tx=>allocateReceipt(tx,c,allocation)),first);
      assert.equal(first.after[0]!.recordedPaidMinor,60000);assert.equal(first.after[0]!.historicalPaidMinor,0);
      await run(c,tx=>allocateReceipt(tx,c,{...allocation,invoiceId:invoiceB,amountMinor:40000,idempotencyKey:'allocate-b'}));
      const paid=(await totals(c))[0]!;assert.equal(paid.recordedPaidMinor,100000);assert.equal(paid.verifiedReceivedMinor,100000);assert.equal(paid.pendingMinor,0);assert.equal(paid.unallocatedMinor,0);
      await assert.rejects(()=>run(c,tx=>allocateReceipt(tx,c,{...allocation,amountMinor:1,idempotencyKey:'extra'})),/exceeds_payable/);
      const refund={invoiceId:invoiceA,receiptId,kind:'refund' as const,amountMinor:20000,currency:'EUR',reason:'Synthetic returned fee',occurredOn:'2026-10-03',idempotencyKey:'refund'};
      const refunded=await run(c,tx=>adjustInvoice(tx,c,refund));assert.deepEqual(await run(c,tx=>adjustInvoice(tx,c,refund)),refunded);
      assert.equal(refunded.after[0]!.verifiedReceivedMinor,80000);assert.equal(refunded.after[0]!.recordedPaidMinor,80000);assert.equal(refunded.after[0]!.pendingMinor,0);assert.equal(refunded.after[0]!.unallocatedMinor,0);
      await assert.rejects(()=>run(c,tx=>adjustInvoice(tx,c,{...refund,amountMinor:50000,idempotencyKey:'excess-refund'})),/refund_exceeds_invoice_receipt/);
      let third='';await run(c,async tx=>{third=(await publishDecision(tx,c,decision(await imported(tx,c,10000,'pending')),{idempotencyKey:'third'})).invoiceId;});
      const credited=await run(c,tx=>adjustInvoice(tx,c,{invoiceId:third,kind:'credit',amountMinor:4000,currency:'EUR',reason:'Synthetic discount',occurredOn:'2026-10-03',idempotencyKey:'credit'}));assert.equal(credited.after[0]!.pendingMinor,6000);assert.equal(credited.after[0]!.invoicedMinor,106000);
      const historical=await run(c,tx=>recordHistoricalReceipt(tx,c,{amountMinor:6000,currency:'EUR',paidOn:'2026-10-03',reference:'synthetic-bank',reason:'Reviewed synthetic bank evidence',idempotencyKey:'historical'}));
      await run(c,tx=>allocateReceipt(tx,c,{receiptId:historical.id,invoiceId:third,amountMinor:6000,currency:'EUR',idempotencyKey:'historical-allocation'}));
      assert.equal((await totals(c))[0]!.verifiedReceivedMinor,80000);assert.equal((await totals(c))[0]!.historicalPaidMinor,6000);
      await assert.rejects(()=>run(c,tx=>allocateReceipt(tx,c,{...allocation,currency:'GBP',idempotencyKey:'wrong-currency'})),/foreign key|exceeds_payable/);
    });

    await t.test('concurrent allocation caps and refund capacity use committed amounts',async()=>{
      const c=ctx(),p=receipt(100000);let a='',b='',r='';await run(c,async tx=>{a=(await publishDecision(tx,c,decision(await imported(tx,c,100000,'pending')),{idempotencyKey:'a'})).invoiceId;b=(await publishDecision(tx,c,decision(await imported(tx,c,100000,'pending')),{idempotencyKey:'b'})).invoiceId;await importConfirmedReceipts(tx,c.businessId,[p]);r=(await tx.query('SELECT id FROM reconciliation_receipts WHERE payment_id=$1',[p.paymentId])).rows[0].id;});
      const settled=await Promise.allSettled([a,b].map((invoiceId,index)=>run(c,tx=>allocateReceipt(tx,c,{invoiceId,receiptId:r,currency:'EUR',amountMinor:60000,idempotencyKey:`parallel-${index}`}))));
      assert.equal(settled.filter(result=>result.status==='fulfilled').length,1);assert.equal(settled.filter(result=>result.status==='rejected').length,1);
      const allocatedTo=settled[0]!.status==='fulfilled'?a:b,other=allocatedTo===a?b:a;
      await run(c,tx=>adjustInvoice(tx,c,{invoiceId:allocatedTo,receiptId:r,kind:'refund',currency:'EUR',amountMinor:20000,reason:'Synthetic partial refund',occurredOn:'2026-10-03',idempotencyKey:'refund'}));
      assert.equal((await totals(c))[0]!.unallocatedMinor,40000);
      await run(c,tx=>allocateReceipt(tx,c,{invoiceId:other,receiptId:r,currency:'EUR',amountMinor:40000,idempotencyKey:'remaining'}));assert.equal((await totals(c))[0]!.unallocatedMinor,0);assert.equal((await totals(c))[0]!.verifiedReceivedMinor,80000);
    });

    await t.test('tenant RLS, staff-only mutation, monetary FKs and atomic audit/outbox',async()=>{
      const c=ctx(),other=ctx();let s='';await run(c,async tx=>{s=await imported(tx,c,5000,'pending');await publishDecision(tx,c,decision(s),{idempotencyKey:'accepted'});});
      await run(other,async tx=>{assert.equal((await tx.query('SELECT count(*) n FROM reconciliation_invoices')).rows[0].n,'0');assert.deepEqual(await reconciliationTotals(tx,other.businessId),[]);});
      await assert.rejects(()=>run(other,tx=>publishDecision(tx,other,decision(s),{idempotencyKey:'cross-tenant'})),/source_not_found/);
      await assert.rejects(()=>run({...c,role:'student'},tx=>publishDecision(tx,{...c,role:'student'},decision(s),{idempotencyKey:'student'})),/business_staff_required/);
      await run(c,async tx=>{assert.equal((await tx.query('SELECT count(*) n FROM reconciliation_audit')).rows[0].n,'1');assert.equal((await tx.query("SELECT count(*) n FROM service_outbox WHERE event->>'businessId'=$1",[c.businessId])).rows[0].n,'1');
        const policies=(await tx.query("SELECT count(*) n FROM pg_class WHERE relnamespace=$1::regnamespace AND relname LIKE 'reconciliation_%' AND relkind='r' AND relrowsecurity AND relforcerowsecurity",[schema])).rows[0].n;assert.equal(policies,'9');});
    });
  } finally {await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}
});
