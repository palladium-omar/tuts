import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { confirmedReceiptSchema, reconciliationDecisionSchema, type ConfirmedReceipt, type ReconciliationDecision, type RequestContext } from '@palladium/contracts';
import { emitEvent } from '@palladium/service-kit';
import { idempotent,requestHash } from './idempotency.js';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
export function reconciliationMinor(value: unknown): number {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new UnprocessableEntityException('reconciliation_numeric_range');
  let integer: bigint;
  try { integer = BigInt(String(value)); } catch { throw new UnprocessableEntityException('reconciliation_numeric_range'); }
  if (integer < 0n || integer > MAX) throw new UnprocessableEntityException('reconciliation_numeric_range');
  return Number(integer);
}
function positive(value: unknown) { const n = reconciliationMinor(value); if (!n) throw new BadRequestException('reconciliation_positive_amount_required'); return n; }
function currency(value: string) { if (!/^[A-Z]{3}$/.test(value)) throw new BadRequestException('reconciliation_currency_invalid'); return value; }
function date(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new BadRequestException('reconciliation_date_invalid'); return value; }
function dateText(value:unknown):string|null { if (value===null || value===undefined) return null;if(value instanceof Date)return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;return String(value).slice(0,10); }
function ctxAccess(ctx: RequestContext) { if (ctx.role === 'student' || ctx.role === 'parent' || ctx.accessScope === 'students') throw new ForbiddenException('reconciliation_business_staff_required'); }

export async function lockReconciliation(tx: PoolClient, businessId: string): Promise<void> {
  const scope = (await tx.query("SELECT current_setting('app.business_id',true) AS business_id")).rows[0]?.business_id;
  if (scope !== businessId) throw new ForbiddenException('reconciliation_tenant_scope_invalid');
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('billing-reconciliation:' || $1,0))", [businessId]);
}

/** One read-only preflight keeps steady-state Dashboard/list reads free of locks/writes. */
export async function reconciliationNeedsProjection(tx:PoolClient,businessId:string):Promise<boolean> {
  const row=(await tx.query(`SELECT EXISTS(
    SELECT 1 FROM invoices i LEFT JOIN reconciliation_invoices c ON c.business_id=i.business_id AND c.origin_kind='native' AND c.origin_id=i.id
    WHERE i.business_id=$1 AND (c.id IS NULL OR c.source_revision<>i.revision OR NOT EXISTS(
      SELECT 1 FROM reconciliation_source_aliases a WHERE a.business_id=i.business_id AND a.kind='native' AND a.source_id=i.id AND a.invoice_id=c.id)
      OR (i.client_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reconciliation_beneficiaries b WHERE b.business_id=i.business_id AND b.invoice_id=c.id AND billing_student_root(b.student_id)=billing_student_root(i.client_id))))
  ) OR EXISTS(
    SELECT 1 FROM payment_allocations p WHERE p.business_id=$1 AND NOT p.simulated AND
      (NOT EXISTS(SELECT 1 FROM reconciliation_receipt_aliases r WHERE r.business_id=p.business_id AND r.payment_id=p.payment_id)
       OR NOT EXISTS(SELECT 1 FROM reconciliation_allocations a WHERE a.business_id=p.business_id AND a.native_payment_id=p.payment_id))
  ) AS needed`,[businessId])).rows[0];
  return row.needed;
}

/** Native obligations and legacy real payments are authoritative; imports stay staged. */
export async function ensureReconciliation(tx: PoolClient, businessId: string): Promise<void> {
  await lockReconciliation(tx, businessId);
  await tx.query(`INSERT INTO reconciliation_invoices
    (business_id,id,origin_kind,origin_id,source_revision,source_snapshot,payer_id,currency,face_minor,declared_paid_minor,status,invoice_date,due_date,service_month)
    SELECT i.business_id,i.id,'native',i.id,i.revision,to_jsonb(i),NULL,i.currency,i.total_minor,0,
      CASE WHEN i.issued_at IS NULL THEN 'draft' ELSE 'issued' END,(coalesce(i.issued_at,i.created_at) AT TIME ZONE 'UTC')::date,(i.due_at AT TIME ZONE 'UTC')::date,i.service_month
    FROM invoices i WHERE i.business_id=$1
    ON CONFLICT(business_id,origin_kind,origin_id) DO UPDATE SET
      source_revision=EXCLUDED.source_revision,
      source_snapshot=CASE WHEN reconciliation_invoices.status='draft' THEN EXCLUDED.source_snapshot ELSE reconciliation_invoices.source_snapshot END,
      face_minor=CASE WHEN reconciliation_invoices.status='draft' THEN EXCLUDED.face_minor ELSE reconciliation_invoices.face_minor END,
      status=EXCLUDED.status,due_date=coalesce(EXCLUDED.due_date,reconciliation_invoices.due_date),service_month=coalesce(EXCLUDED.service_month,reconciliation_invoices.service_month),
      invoice_date=EXCLUDED.invoice_date,revision=reconciliation_invoices.revision+1,updated_at=now()
    WHERE reconciliation_invoices.source_revision<>EXCLUDED.source_revision`, [businessId]);
  await tx.query(`INSERT INTO reconciliation_source_aliases(business_id,kind,source_id,source_revision,source_snapshot,invoice_id)
    SELECT business_id,'native',origin_id,source_revision,source_snapshot,id FROM reconciliation_invoices WHERE business_id=$1 AND origin_kind='native'
    ON CONFLICT(business_id,kind,source_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,source_snapshot=EXCLUDED.source_snapshot
      WHERE reconciliation_source_aliases.source_revision<>EXCLUDED.source_revision`, [businessId]);
  await tx.query(`INSERT INTO reconciliation_beneficiaries(business_id,invoice_id,student_id)
    SELECT i.business_id,a.invoice_id,billing_student_root(i.client_id) FROM invoices i JOIN reconciliation_source_aliases a
      ON a.business_id=i.business_id AND a.kind='native' AND a.source_id=i.id WHERE i.business_id=$1 AND i.client_id IS NOT NULL
    ON CONFLICT DO NOTHING`, [businessId]);
  const conflict = (await tx.query(`SELECT 1 FROM payment_allocations p JOIN reconciliation_receipt_aliases a ON a.business_id=p.business_id AND a.payment_id=p.payment_id
    JOIN reconciliation_receipts r ON r.business_id=a.business_id AND r.id=a.receipt_id
    WHERE p.business_id=$1 AND NOT p.simulated AND (r.amount_minor<>p.amount_minor OR r.currency<>p.currency OR r.provider<>p.provider OR r.source_invoice_id<>p.invoice_id OR r.evidence<>'provider') LIMIT 1`, [businessId])).rowCount;
  if (conflict) throw new ConflictException('reconciliation_payment_identity_conflict');
  await tx.query(`INSERT INTO reconciliation_receipts(business_id,id,payment_id,source_invoice_id,provider,provider_reference,currency,amount_minor,paid_at,evidence,legacy)
    SELECT p.business_id,p.payment_id,p.payment_id,p.invoice_id,p.provider,'legacy:' || p.payment_id::text,p.currency,p.amount_minor,p.created_at,'provider',true
    FROM payment_allocations p WHERE p.business_id=$1 AND NOT p.simulated
      AND NOT EXISTS(SELECT 1 FROM reconciliation_receipt_aliases a WHERE a.business_id=p.business_id AND a.payment_id=p.payment_id)
    ON CONFLICT(business_id,payment_id) DO NOTHING`, [businessId]);
  await tx.query(`INSERT INTO reconciliation_receipt_aliases(business_id,payment_id,receipt_id)
    SELECT business_id,payment_id,id FROM reconciliation_receipts WHERE business_id=$1 AND payment_id IS NOT NULL ON CONFLICT DO NOTHING`, [businessId]);
  await tx.query(`WITH inserted AS (INSERT INTO reconciliation_allocations(business_id,id,receipt_id,invoice_id,amount_minor,currency,native_payment_id)
    SELECT p.business_id,p.payment_id,r.receipt_id,s.invoice_id,p.amount_minor,p.currency,p.payment_id FROM payment_allocations p
    JOIN reconciliation_receipt_aliases r ON r.business_id=p.business_id AND r.payment_id=p.payment_id
    JOIN reconciliation_source_aliases s ON s.business_id=p.business_id AND s.kind='native' AND s.source_id=p.invoice_id
    WHERE p.business_id=$1 AND NOT p.simulated AND NOT EXISTS(SELECT 1 FROM reconciliation_allocations a WHERE a.business_id=p.business_id AND a.native_payment_id=p.payment_id)
    ON CONFLICT(business_id,native_payment_id) DO NOTHING RETURNING invoice_id)
    UPDATE reconciliation_invoices SET revision=revision+1,updated_at=now() WHERE business_id=$1 AND id IN(SELECT invoice_id FROM inserted)`, [businessId]);
}

export type ReconciliationCurrencyTotal = {
  currency: string; workValueMinor: number; invoicedMinor: number; recordedPaidMinor: number;
  verifiedReceivedMinor: number; historicalPaidMinor: number; outstandingMinor: number;
  pendingMinor: number; unsentMinor: number; unresolvedInvoices: number; unallocatedReceipts: number;
  unallocatedMinor: number; staleWorkLinks: number; staleSources: number;
};
/** Billing's shared settlement formula. All claims overlap, so their maximum is used. */
export const reconciliationClaimsCte = `reconciliation_allocated_claims AS (
  SELECT a.invoice_id,sum(a.amount_minor) allocated_minor,
    coalesce(sum(a.amount_minor) FILTER(WHERE r.evidence='provider'),0) provider_allocated_minor
  FROM reconciliation_allocations a JOIN reconciliation_receipts r ON r.business_id=a.business_id AND r.id=a.receipt_id
  WHERE a.business_id=$1 AND r.evidence<>'simulated' GROUP BY a.invoice_id
), reconciliation_adjustment_claims AS (
  SELECT j.invoice_id,coalesce(sum(j.amount_minor) FILTER(WHERE j.kind='credit'),0) credit_minor,
    coalesce(sum(j.amount_minor) FILTER(WHERE j.kind='refund'),0) refund_minor,
    coalesce(sum(j.amount_minor) FILTER(WHERE j.kind='refund' AND r.evidence='historical'),0) historical_refund_minor,
    coalesce(sum(j.amount_minor) FILTER(WHERE j.kind='refund' AND r.evidence='provider'),0) provider_refund_minor
  FROM reconciliation_adjustments j LEFT JOIN reconciliation_receipts r ON r.business_id=j.business_id AND r.id=j.receipt_id
  WHERE j.business_id=$1 GROUP BY j.invoice_id
), reconciliation_alias_claims AS (
  SELECT invoice_id,max((source_snapshot->>'amount_minor')::numeric) alias_paid_minor
  FROM reconciliation_source_aliases WHERE business_id=$1 AND kind='imported' AND source_snapshot->>'status'='paid' GROUP BY invoice_id
), reconciliation_covered_claims AS (
  SELECT invoice_id,sum(amount_minor) covered_paid_minor FROM reconciliation_work_coverage
  WHERE business_id=$1 AND work_status='paid' GROUP BY invoice_id
), reconciliation_invoice_claims AS (
  SELECT i.*,claim.paid_claim_minor,greatest(i.face_minor-coalesce(j.credit_minor,0),0) payable_minor,
    greatest(claim.paid_claim_minor-coalesce(j.refund_minor,0),0) recorded_paid_minor,
    greatest(i.face_minor-coalesce(j.credit_minor,0)-claim.paid_claim_minor,0) balance_minor,
    greatest(claim.paid_claim_minor-coalesce(a.provider_allocated_minor,0)-coalesce(j.historical_refund_minor,0),0) historical_paid_minor,
    greatest(coalesce(a.provider_allocated_minor,0)-coalesce(j.provider_refund_minor,0),0) verified_paid_minor,
    coalesce(a.allocated_minor,0) allocated_minor,coalesce(a.provider_allocated_minor,0) provider_allocated_minor,
    coalesce(j.credit_minor,0) credit_minor,coalesce(j.refund_minor,0) refund_minor,coalesce(j.provider_refund_minor,0) provider_refund_minor,
    least(i.face_minor,coalesce(s.alias_paid_minor,0)) alias_paid_minor,least(i.face_minor,coalesce(w.covered_paid_minor,0)) covered_paid_minor
  FROM reconciliation_invoices i LEFT JOIN reconciliation_allocated_claims a ON a.invoice_id=i.id
  LEFT JOIN reconciliation_adjustment_claims j ON j.invoice_id=i.id LEFT JOIN reconciliation_alias_claims s ON s.invoice_id=i.id
  LEFT JOIN reconciliation_covered_claims w ON w.invoice_id=i.id CROSS JOIN LATERAL (
    SELECT least(i.face_minor,greatest(i.declared_paid_minor,coalesce(s.alias_paid_minor,0),coalesce(w.covered_paid_minor,0),coalesce(a.allocated_minor,0))) paid_claim_minor
  ) claim WHERE i.business_id=$1
)`;
/** Fixed aggregates. A reviewed stale work snapshot remains reserved until corrected. */
export async function reconciliationTotals(tx: PoolClient, businessId: string): Promise<ReconciliationCurrencyTotal[]> {
  const rows = (await tx.query(`WITH ${reconciliationClaimsCte}, covered AS (
    SELECT work_id,sum(amount_minor) covered,min(work_amount_minor) snapshot_amount,min(work_status) snapshot_status,min(currency) snapshot_currency
    FROM reconciliation_work_coverage WHERE business_id=$1 GROUP BY work_id
  ), work AS (
    SELECT coalesce(c.snapshot_currency,w.currency) currency,coalesce(c.snapshot_amount,w.amount_minor) amount,
      greatest(coalesce(c.snapshot_amount,w.amount_minor)-coalesce(c.covered,0),0) residual,coalesce(c.snapshot_status,w.status) status
    FROM billing_work_log w LEFT JOIN covered c ON c.work_id=w.id WHERE w.business_id=$1
  ), raw_work_totals AS (SELECT currency,sum(amount_minor) value FROM billing_work_log WHERE business_id=$1 GROUP BY currency), work_totals AS (
    SELECT currency,coalesce(sum(residual) FILTER(WHERE status='paid'),0) paid,
      coalesce(sum(residual) FILTER(WHERE status='pending'),0) pending,coalesce(sum(residual) FILTER(WHERE status='unsent'),0) unsent FROM work GROUP BY currency
  ), invoice_totals AS (
    SELECT currency,coalesce(sum(payable_minor) FILTER(WHERE status<>'draft'),0) invoiced,sum(recorded_paid_minor) paid,sum(historical_paid_minor) historical,coalesce(sum(balance_minor) FILTER(WHERE status<>'draft'),0) outstanding,
      coalesce(sum(balance_minor) FILTER(WHERE status<>'draft'),0) pending,coalesce(sum(balance_minor) FILTER(WHERE status='draft'),0) unsent FROM reconciliation_invoice_claims GROUP BY currency
  ), receipt_values AS (
    SELECT r.currency,r.evidence,greatest(r.amount_minor-coalesce(f.refund,0),0) net,
      greatest(r.amount_minor-coalesce(a.paid,0),0) unallocated
    FROM reconciliation_receipts r LEFT JOIN (SELECT receipt_id,sum(amount_minor) paid FROM reconciliation_allocations WHERE business_id=$1 GROUP BY receipt_id) a ON a.receipt_id=r.id
    LEFT JOIN (SELECT receipt_id,sum(amount_minor) refund FROM reconciliation_adjustments WHERE business_id=$1 AND kind='refund' GROUP BY receipt_id) f ON f.receipt_id=r.id WHERE r.business_id=$1
  ), receipt_totals AS (
    SELECT currency,coalesce(sum(net) FILTER(WHERE evidence='provider'),0) verified,
      coalesce(sum(unallocated) FILTER(WHERE evidence<>'simulated'),0) unallocated,count(*) FILTER(WHERE evidence<>'simulated' AND unallocated>0) unresolved FROM receipt_values GROUP BY currency
  ), staged AS (
    SELECT h.currency,count(*) n FROM billing_invoice_history h WHERE h.business_id=$1 AND NOT EXISTS(
      SELECT 1 FROM reconciliation_source_aliases a WHERE a.business_id=h.business_id AND a.kind='imported' AND a.source_id=h.id) GROUP BY h.currency
  ), stale_work AS (
    SELECT c.currency,count(*) n FROM reconciliation_work_coverage c JOIN billing_work_log w ON w.business_id=c.business_id AND w.id=c.work_id
    WHERE c.business_id=$1 AND c.work_revision<>w.revision GROUP BY c.currency
  ), stale_sources AS (
    SELECT i.currency,count(*) n FROM reconciliation_source_aliases a JOIN reconciliation_invoices i ON i.business_id=a.business_id AND i.id=a.invoice_id
    LEFT JOIN billing_invoice_history h ON a.kind='imported' AND h.business_id=a.business_id AND h.id=a.source_id
    LEFT JOIN invoices n ON a.kind='native' AND n.business_id=a.business_id AND n.id=a.source_id
    WHERE a.business_id=$1 AND a.source_revision<>coalesce(h.revision,n.revision) GROUP BY i.currency
  ), currencies AS (SELECT currency FROM raw_work_totals UNION SELECT currency FROM work_totals UNION SELECT currency FROM invoice_totals UNION SELECT currency FROM receipt_totals UNION SELECT currency FROM staged)
  SELECT c.currency,coalesce(rw.value,0) work_value,coalesce(i.invoiced,0) invoiced,
    coalesce(w.paid,0)+coalesce(i.paid,0) recorded_paid,coalesce(r.verified,0) verified,coalesce(w.paid,0)+coalesce(i.historical,0) historical,
    coalesce(i.outstanding,0) outstanding,coalesce(w.pending,0)+coalesce(i.pending,0) pending,coalesce(w.unsent,0)+coalesce(i.unsent,0) unsent,
    coalesce(s.n,0) unresolved,coalesce(r.unresolved,0) unallocated_receipts,coalesce(r.unallocated,0) unallocated,
    coalesce(sw.n,0) stale_work,coalesce(ss.n,0) stale_sources
  FROM currencies c LEFT JOIN raw_work_totals rw USING(currency) LEFT JOIN work_totals w USING(currency) LEFT JOIN invoice_totals i USING(currency) LEFT JOIN receipt_totals r USING(currency)
    LEFT JOIN staged s USING(currency) LEFT JOIN stale_work sw USING(currency) LEFT JOIN stale_sources ss USING(currency) ORDER BY c.currency`, [businessId])).rows;
  return rows.map(row => ({currency: row.currency, workValueMinor: reconciliationMinor(row.work_value), invoicedMinor: reconciliationMinor(row.invoiced),
    recordedPaidMinor: reconciliationMinor(row.recorded_paid), verifiedReceivedMinor: reconciliationMinor(row.verified), historicalPaidMinor: reconciliationMinor(row.historical),
    outstandingMinor: reconciliationMinor(row.outstanding),pendingMinor: reconciliationMinor(row.pending),unsentMinor: reconciliationMinor(row.unsent),
    unresolvedInvoices: reconciliationMinor(row.unresolved),unallocatedReceipts: reconciliationMinor(row.unallocated_receipts),unallocatedMinor: reconciliationMinor(row.unallocated),
    staleWorkLinks: reconciliationMinor(row.stale_work),staleSources: reconciliationMinor(row.stale_sources)}));
}

export async function reconciliationInvoiceBalances(tx: PoolClient,businessId:string,studentId?:string) {
  const rows=(await tx.query(`WITH ${reconciliationClaimsCte} SELECT i.*,
    coalesce((SELECT array_agg(student_id ORDER BY student_id) FROM reconciliation_beneficiaries b WHERE b.business_id=i.business_id AND b.invoice_id=i.id),'{}'::uuid[]) student_ids
  FROM reconciliation_invoice_claims i
  WHERE i.business_id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM reconciliation_beneficiaries b WHERE b.business_id=i.business_id AND b.invoice_id=i.id AND billing_student_root(b.student_id)=billing_student_root($2::uuid)))
  ORDER BY i.invoice_date DESC,i.id`,[businessId,studentId??null])).rows;
  return rows.map(row=>({...row,face_minor:reconciliationMinor(row.face_minor),declared_paid_minor:reconciliationMinor(row.declared_paid_minor),
    payable_minor:reconciliationMinor(row.payable_minor),recorded_paid_minor:reconciliationMinor(row.recorded_paid_minor),balance_minor:reconciliationMinor(row.balance_minor),
    allocated_minor:reconciliationMinor(row.allocated_minor),credit_minor:reconciliationMinor(row.credit_minor),refund_minor:reconciliationMinor(row.refund_minor)}));
}

async function audit(tx: PoolClient, ctx: RequestContext, operation: string, details: unknown,subjectId?:string,hash?:string) {
  await tx.query('INSERT INTO reconciliation_audit(business_id,id,operation,actor_id,request_id,details,subject_id,request_hash) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
    [ctx.businessId,randomUUID(),operation,ctx.sub,ctx.requestId,JSON.stringify(details),subjectId??null,hash??null]);
  await emitEvent(tx,{type:'billing.reconciliation-updated.v1',producer:'billing',businessId:ctx.businessId,correlationId:ctx.requestId,data:{operation}});
}
type DecisionResult = {invoiceId: string; before: ReconciliationCurrencyTotal[]; after: ReconciliationCurrencyTotal[];
  affectedInvoices:{invoiceId:string;revision:number;workIds:string[]}[];
  guards: {sourceRevision: number; invoiceRevision: number; work: {workId: string; revision: number}[];invoices:{invoiceId:string;revision:number}[]}};

async function applyDecision(tx: PoolClient, ctx: RequestContext, decision: ReconciliationDecision,requireGuards:boolean): Promise<DecisionResult> {
  const before = await reconciliationTotals(tx,ctx.businessId);
  const table=decision.source.kind==='native'?'invoices':'billing_invoice_history';
  const source=(await tx.query(`SELECT * FROM ${table} WHERE business_id=$1 AND id=$2 FOR UPDATE`,[ctx.businessId,decision.source.id])).rows[0];
  if (!source) throw new NotFoundException('reconciliation_source_not_found');
  if (source.revision!==decision.source.revision) throw new ConflictException('reconciliation_source_revision_conflict');
  const alias=(await tx.query('SELECT * FROM reconciliation_source_aliases WHERE business_id=$1 AND kind=$2 AND source_id=$3 FOR UPDATE',[ctx.businessId,decision.source.kind,decision.source.id])).rows[0];
  if (alias && decision.choice==='new') throw new ConflictException('reconciliation_accepted_source_requires_invoice_revision');
  if (alias && alias.source_revision!==source.revision) throw new ConflictException('reconciliation_accepted_source_stale');
  if (decision.source.kind==='native' && decision.choice==='existing' && decision.invoiceId!==alias?.invoice_id) throw new ConflictException('reconciliation_native_obligation_cannot_merge');
  if (alias && decision.choice==='existing' && alias.invoice_id!==decision.invoiceId) throw new ConflictException('reconciliation_source_already_associated');
  const invoiceId=decision.choice==='existing'?decision.invoiceId!:alias?.invoice_id??randomUUID();
  let invoice=(await tx.query('SELECT * FROM reconciliation_invoices WHERE business_id=$1 AND id=$2 FOR UPDATE',[ctx.businessId,invoiceId])).rows[0];
  const supplied=new Map((decision.invoiceGuards??[]).map(guard=>[guard.invoiceId,guard.revision]));
  const guarded=(await tx.query('SELECT id,revision FROM reconciliation_invoices WHERE business_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[ctx.businessId,[...supplied.keys()]])).rows;
  if(guarded.length!==supplied.size || guarded.some(row=>supplied.get(row.id)!==row.revision))throw new ConflictException('reconciliation_affected_invoice_revision_conflict');
  const workPlans: {link:ReconciliationDecision['workLinks'][number];work:Record<string,any>;prior:Record<string,any>[];refresh:boolean}[]=[];
  const otherInvoiceGuards=new Map<string,number>();
  for (const link of [...decision.workLinks].sort((a,b)=>a.workId.localeCompare(b.workId))) {
    const work=(await tx.query('SELECT * FROM billing_work_log WHERE business_id=$1 AND id=$2 FOR UPDATE',[ctx.businessId,link.workId])).rows[0];
    if (!work) throw new NotFoundException('reconciliation_work_not_found');
    if (work.revision!==link.revision) throw new ConflictException('reconciliation_work_revision_conflict');
    if (work.currency!==(invoice?.currency??source.currency)) throw new ConflictException('reconciliation_currency_mismatch');
    const prior=(await tx.query(`SELECT c.invoice_id,c.amount_minor,c.work_revision,c.work_status,c.work_amount_minor,c.currency,i.currency AS invoice_currency,i.revision AS invoice_revision
      FROM reconciliation_work_coverage c JOIN reconciliation_invoices i ON i.business_id=c.business_id AND i.id=c.invoice_id
      WHERE c.business_id=$1 AND c.work_id=$2 ORDER BY c.invoice_id FOR UPDATE OF c,i`,[ctx.businessId,link.workId])).rows;
    const covered=prior.filter(row=>row.invoice_id!==invoiceId).reduce((sum,row)=>sum+BigInt(row.amount_minor),BigInt(link.amountMinor));
    if (covered>BigInt(work.amount_minor)) throw new ConflictException('reconciliation_work_coverage_exceeds_value');
    if (prior.some(row=>row.invoice_currency!==work.currency)) throw new ConflictException('reconciliation_shared_work_currency_conflict');
    const refresh=prior.some(row=>row.work_revision!==work.revision || row.work_status!==work.status || String(row.work_amount_minor)!==String(work.amount_minor) || row.currency!==work.currency);
    if(refresh)for(const row of prior)if(row.invoice_id!==invoiceId)otherInvoiceGuards.set(row.invoice_id,row.invoice_revision);
    workPlans.push({link,work,prior,refresh});
  }
  if(otherInvoiceGuards.size>200)throw new BadRequestException('reconciliation_affected_invoice_limit');
  if([...supplied.keys()].some(id=>!otherInvoiceGuards.has(id)) || (requireGuards && (supplied.size!==otherInvoiceGuards.size || [...otherInvoiceGuards].some(([id,revision])=>supplied.get(id)!==revision))))throw new ConflictException('reconciliation_affected_invoice_guards_conflict');
  if (decision.choice==='existing') {
    if (!invoice) throw new NotFoundException('reconciliation_invoice_not_found');
    if (invoice.revision!==decision.invoiceRevision) throw new ConflictException('reconciliation_invoice_revision_conflict');
    if (invoice.currency!==source.currency) throw new ConflictException('reconciliation_currency_mismatch');
    if ((decision.payerId && invoice.payer_id && decision.payerId!==invoice.payer_id) ||
      (decision.dueDate && invoice.due_date && decision.dueDate!==dateText(invoice.due_date)) ||
      (decision.serviceMonth && invoice.service_month && decision.serviceMonth!==dateText(invoice.service_month)!.slice(0,7))) throw new ConflictException('reconciliation_reviewed_metadata_conflict');
    await tx.query(`UPDATE reconciliation_invoices SET payer_id=coalesce(payer_id,$3),due_date=coalesce(due_date,$4::date),service_month=coalesce(service_month,$5::date)
      WHERE business_id=$1 AND id=$2`,[ctx.businessId,invoiceId,decision.payerId??null,decision.dueDate??null,decision.serviceMonth?`${decision.serviceMonth}-01`:null]);
  }
  if (!invoice) {
    const face=reconciliationMinor(source.amount_minor),status=source.status==='unsent'?'draft':source.status==='paid'?'settled':'issued';
    invoice=(await tx.query(`INSERT INTO reconciliation_invoices(business_id,id,origin_kind,origin_id,source_revision,source_snapshot,payer_id,currency,face_minor,declared_paid_minor,status,invoice_date,due_date,service_month)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ctx.businessId,invoiceId,decision.source.kind,source.id,source.revision,JSON.stringify(source),decision.payerId??null,source.currency,face,status==='settled'?face:0,status,source.invoice_date,decision.dueDate??null,decision.serviceMonth?`${decision.serviceMonth}-01`:null])).rows[0];
  }
  if (!alias) await tx.query('INSERT INTO reconciliation_source_aliases(business_id,kind,source_id,source_revision,source_snapshot,invoice_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[ctx.businessId,decision.source.kind,source.id,source.revision,JSON.stringify(source),invoiceId]);
  // Aliases attach evidence; they never rewrite an accepted obligation's face/status/snapshot.
  for (const student of decision.studentIds) await tx.query('INSERT INTO reconciliation_beneficiaries(business_id,invoice_id,student_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.businessId,invoiceId,student]);
  const affected=new Map<string,Set<string>>([[invoiceId,new Set()]]);
  for (const {link,work,prior,refresh} of workPlans) {
    await tx.query(`INSERT INTO reconciliation_work_coverage(business_id,invoice_id,work_id,amount_minor,work_revision,work_snapshot,work_amount_minor,work_status,currency)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT(business_id,invoice_id,work_id) DO UPDATE SET
      amount_minor=EXCLUDED.amount_minor,work_revision=EXCLUDED.work_revision,work_snapshot=EXCLUDED.work_snapshot,
      work_amount_minor=EXCLUDED.work_amount_minor,work_status=EXCLUDED.work_status,currency=EXCLUDED.currency,updated_at=now()`,
      [ctx.businessId,invoiceId,link.workId,link.amountMinor,link.revision,JSON.stringify(work),work.amount_minor,work.status,work.currency]);
    affected.get(invoiceId)!.add(link.workId);
    if (refresh) {
      await tx.query(`UPDATE reconciliation_work_coverage SET work_revision=$3,work_snapshot=$4::jsonb,work_amount_minor=$5,work_status=$6,currency=$7,updated_at=now()
        WHERE business_id=$1 AND work_id=$2`,[ctx.businessId,link.workId,work.revision,JSON.stringify(work),work.amount_minor,work.status,work.currency]);
      for(const row of prior){if(!affected.has(row.invoice_id))affected.set(row.invoice_id,new Set());affected.get(row.invoice_id)!.add(link.workId);}
    }
  }
  const revised=(await tx.query('UPDATE reconciliation_invoices SET revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=ANY($2::uuid[]) RETURNING id,revision',[ctx.businessId,[...affected.keys()]])).rows;
  const affectedInvoices=revised.map(row=>({invoiceId:row.id,revision:row.revision,workIds:[...affected.get(row.id)!].sort()})).sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId));
  // Validate deferred snapshot agreement before returning a preview/publication result.
  await tx.query('SET CONSTRAINTS reconciliation_work_snapshot_consistency IMMEDIATE');
  await tx.query('SET CONSTRAINTS reconciliation_work_snapshot_consistency DEFERRED');
  return {invoiceId,before,after:await reconciliationTotals(tx,ctx.businessId),affectedInvoices,guards:{sourceRevision:source.revision,invoiceRevision:revised.find(row=>row.id===invoiceId)!.revision,work:decision.workLinks.map(link=>({workId:link.workId,revision:link.revision})),invoices:[...otherInvoiceGuards].map(([invoiceId,revision])=>({invoiceId,revision})).sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId))}};
}

export async function publishDecision(tx: PoolClient, ctx: RequestContext, input: ReconciliationDecision, options: {idempotencyKey: string}): Promise<DecisionResult> {
  ctxAccess(ctx);const decision=reconciliationDecisionSchema.parse(input);await ensureReconciliation(tx,ctx.businessId);
  return idempotent(tx,ctx.businessId,'reconciliation.publish',options.idempotencyKey,decision,async()=>{
    const hash=requestHash(decision);
    const previous=(await tx.query("SELECT details->'result' AS result FROM reconciliation_audit WHERE business_id=$1 AND operation='publish' AND subject_id=$2 AND request_hash=$3",[ctx.businessId,decision.source.id,hash])).rows[0];
    if (previous) return previous.result as DecisionResult;
    const result=await applyDecision(tx,ctx,decision,true);await audit(tx,ctx,'publish',{decision,result},decision.source.id,hash);return result;
  });
}
export async function previewDecision(tx: PoolClient, ctx: RequestContext, input: ReconciliationDecision): Promise<DecisionResult> {
  ctxAccess(ctx);const decision=reconciliationDecisionSchema.parse(input);
  await tx.query('SAVEPOINT reconciliation_preview');
  try { await ensureReconciliation(tx,ctx.businessId);return await applyDecision(tx,ctx,decision,false); }
  finally { await tx.query('ROLLBACK TO SAVEPOINT reconciliation_preview');await tx.query('RELEASE SAVEPOINT reconciliation_preview'); }
}

export async function importConfirmedReceipts(tx: PoolClient, businessId: string, items: ConfirmedReceipt[]): Promise<{imported: number; enriched: number; unchanged: number}> {
  if (items.length>200) throw new BadRequestException('reconciliation_receipt_batch_limit');
  const parsed=items.map(item=>confirmedReceiptSchema.parse(item));await ensureReconciliation(tx,businessId);
  const result={imported:0,enriched:0,unchanged:0};
  let allocated=0;
  for (const item of parsed) {
    if (item.provider==='sandbox' && !item.simulated) throw new ConflictException('reconciliation_simulated_provider_conflict');
    const evidence=item.simulated?'simulated':'provider';
    const candidates=(await tx.query(`SELECT r.* FROM reconciliation_receipts r WHERE r.business_id=$1 AND
      (r.payment_id=$2 OR r.id IN(SELECT receipt_id FROM reconciliation_receipt_aliases WHERE business_id=$1 AND payment_id=$2)
      OR (r.provider=$3 AND r.connection_id=$4 AND r.provider_reference=$5)) FOR UPDATE`,[businessId,item.paymentId,item.provider,item.connectionId,item.providerReference])).rows;
    if (candidates.length>1) throw new ConflictException('reconciliation_receipt_identity_conflict');
    let receipt=candidates[0];
    if (receipt) {
      if (receipt.payment_id!==item.paymentId || receipt.source_invoice_id!==item.invoiceId || receipt.provider!==item.provider || receipt.currency!==item.currency || reconciliationMinor(receipt.amount_minor)!==item.amountMinor || receipt.evidence!==evidence ||
        (!receipt.legacy && (receipt.connection_id!==item.connectionId || receipt.provider_reference!==item.providerReference || new Date(receipt.paid_at).toISOString()!==new Date(item.confirmedAt).toISOString()))) throw new ConflictException('reconciliation_receipt_identity_conflict');
      if (receipt.legacy) { await tx.query('UPDATE reconciliation_receipts SET connection_id=$3,provider_reference=$4,paid_at=$5,legacy=false,revision=revision+1 WHERE business_id=$1 AND id=$2',[businessId,receipt.id,item.connectionId,item.providerReference,item.confirmedAt]);result.enriched++; }
      else result.unchanged++;
    } else {
      receipt=(await tx.query(`INSERT INTO reconciliation_receipts(business_id,id,payment_id,source_invoice_id,provider,connection_id,provider_reference,currency,amount_minor,paid_at,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[businessId,randomUUID(),item.paymentId,item.invoiceId,item.provider,item.connectionId,item.providerReference,item.currency,item.amountMinor,item.confirmedAt,evidence])).rows[0];result.imported++;
    }
    await tx.query('INSERT INTO reconciliation_receipt_aliases(business_id,payment_id,receipt_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[businessId,item.paymentId,receipt.id]);
    const native=(await tx.query('SELECT * FROM payment_allocations WHERE business_id=$1 AND payment_id=$2',[businessId,item.paymentId])).rows[0];
    if (native && (native.invoice_id!==item.invoiceId || native.provider!==item.provider || native.currency!==item.currency || reconciliationMinor(native.amount_minor)!==item.amountMinor || native.simulated!==item.simulated)) throw new ConflictException('reconciliation_payment_identity_conflict');
    const existing=(await tx.query('SELECT invoice_id,amount_minor FROM reconciliation_allocations WHERE business_id=$1 AND native_payment_id=$2',[businessId,item.paymentId])).rows[0];
    const alias=(await tx.query("SELECT invoice_id FROM reconciliation_source_aliases WHERE business_id=$1 AND kind='native' AND source_id=$2",[businessId,item.invoiceId])).rows[0];
    if (existing && (!alias || existing.invoice_id!==alias.invoice_id || reconciliationMinor(existing.amount_minor)!==item.amountMinor)) throw new ConflictException('reconciliation_payment_invoice_conflict');
    if (!item.simulated && alias && !existing) {
      await tx.query('INSERT INTO reconciliation_allocations(business_id,id,receipt_id,invoice_id,amount_minor,currency,native_payment_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[businessId,item.paymentId,receipt.id,alias.invoice_id,item.amountMinor,item.currency,item.paymentId]);
      await tx.query('UPDATE reconciliation_invoices SET revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2',[businessId,alias.invoice_id]);
      await tx.query('UPDATE reconciliation_receipts SET revision=revision+1 WHERE business_id=$1 AND id=$2',[businessId,receipt.id]);
      allocated++;
    }
  }
  if (result.imported || result.enriched || allocated) {
    const requestId=randomUUID();
    await tx.query('INSERT INTO reconciliation_audit(business_id,id,operation,actor_id,request_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[businessId,randomUUID(),'confirmed-receipt-projection','payments',requestId,JSON.stringify({...result,allocated,paymentIds:parsed.map(item=>item.paymentId)})]);
    await emitEvent(tx,{type:'billing.reconciliation-updated.v1',producer:'billing',businessId,correlationId:requestId,data:{operation:'confirmed-receipt-projection',...result,allocated}});
  }
  return result;
}

type AllocationInput={receiptId: string;invoiceId: string;amountMinor: number;currency: string;idempotencyKey: string};
export async function allocateReceipt(tx: PoolClient, ctx: RequestContext, input: AllocationInput) {
  ctxAccess(ctx);positive(input.amountMinor);currency(input.currency);await ensureReconciliation(tx,ctx.businessId);
  return idempotent(tx,ctx.businessId,'reconciliation.allocate',input.idempotencyKey,input,async()=>{
    const before=await reconciliationTotals(tx,ctx.businessId),id=randomUUID();
    const receipt=(await tx.query('SELECT * FROM reconciliation_receipts WHERE business_id=$1 AND id=$2 FOR UPDATE',[ctx.businessId,input.receiptId])).rows[0];
    if (!receipt) throw new NotFoundException('reconciliation_receipt_not_found');
    if (receipt.evidence==='simulated') throw new ConflictException('reconciliation_simulated_receipt_not_allocatable');
    await tx.query('INSERT INTO reconciliation_allocations(business_id,id,receipt_id,invoice_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6)',[ctx.businessId,id,input.receiptId,input.invoiceId,input.amountMinor,input.currency]);
    await tx.query('UPDATE reconciliation_invoices SET revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2',[ctx.businessId,input.invoiceId]);
    await tx.query('UPDATE reconciliation_receipts SET revision=revision+1 WHERE business_id=$1 AND id=$2',[ctx.businessId,input.receiptId]);
    const result={id,before,after:await reconciliationTotals(tx,ctx.businessId)};await audit(tx,ctx,'allocate',{input,result});return result;
  });
}
type AdjustmentInput={invoiceId:string;kind:'credit'|'refund';receiptId?:string;amountMinor:number;currency:string;reason:string;occurredOn:string;idempotencyKey:string};
export async function adjustInvoice(tx: PoolClient,ctx: RequestContext,input:AdjustmentInput) {
  ctxAccess(ctx);positive(input.amountMinor);currency(input.currency);date(input.occurredOn);
  if (!['credit','refund'].includes(input.kind) || !input.reason.trim() || input.reason.length>500 || (input.kind==='refund')!==!!input.receiptId) throw new BadRequestException('reconciliation_adjustment_invalid');
  await ensureReconciliation(tx,ctx.businessId);
  return idempotent(tx,ctx.businessId,'reconciliation.adjust',input.idempotencyKey,input,async()=>{
    const before=await reconciliationTotals(tx,ctx.businessId),id=randomUUID();
    await tx.query('INSERT INTO reconciliation_adjustments(business_id,id,invoice_id,receipt_id,kind,amount_minor,currency,reason,occurred_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.businessId,id,input.invoiceId,input.receiptId??null,input.kind,input.amountMinor,input.currency,input.reason,input.occurredOn]);
    await tx.query('UPDATE reconciliation_invoices SET revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2',[ctx.businessId,input.invoiceId]);
    const result={id,before,after:await reconciliationTotals(tx,ctx.businessId)};await audit(tx,ctx,'adjust',{input,result});return result;
  });
}
type HistoricalReceiptInput={amountMinor:number;currency:string;paidOn:string;reference:string;reason:string;idempotencyKey:string};
export async function recordHistoricalReceipt(tx:PoolClient,ctx:RequestContext,input:HistoricalReceiptInput) {
  ctxAccess(ctx);positive(input.amountMinor);currency(input.currency);date(input.paidOn);
  if (!input.reference.trim() || input.reference.length>200 || !input.reason.trim() || input.reason.length>500) throw new BadRequestException('reconciliation_historical_evidence_required');
  await ensureReconciliation(tx,ctx.businessId);
  return idempotent(tx,ctx.businessId,'reconciliation.historical',input.idempotencyKey,input,async()=>{
    const before=await reconciliationTotals(tx,ctx.businessId),id=randomUUID();
    const existing=(await tx.query("SELECT * FROM reconciliation_receipts WHERE business_id=$1 AND evidence='historical' AND provider_reference=$2",[ctx.businessId,input.reference])).rows[0];
    if (existing) throw new ConflictException('reconciliation_historical_reference_exists');
    await tx.query(`INSERT INTO reconciliation_receipts(business_id,id,provider,provider_reference,currency,amount_minor,paid_at,evidence,reason)
      VALUES($1,$2,'historical_bank',$3,$4,$5,$6,'historical',$7)`,[ctx.businessId,id,input.reference,input.currency,input.amountMinor,`${input.paidOn}T00:00:00Z`,input.reason]);
    const result={id,before,after:await reconciliationTotals(tx,ctx.businessId)};await audit(tx,ctx,'historical_receipt',{input,result});return result;
  });
}
