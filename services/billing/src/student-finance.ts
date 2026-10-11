import { Controller, Get, Inject, Injectable, Query, ForbiddenException, UnprocessableEntityException, type OnModuleInit } from '@nestjs/common';
import { CurrentContext, Database, EventBus, Permissions, Roles, StudentScoped, assertPermission, assertStudentAccess, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { dayView } from './history.js';
import { ensureReconciliation, reconciliationNeedsProjection, reconciliationClaimsCte } from './reconciliation-engine.js';

const querySchema = z.object({ studentId: z.uuid(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
function safeAmount(value: unknown): number {
  const number = Number(value);
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(number) || number < 0)
    throw new UnprocessableEntityException('Financial amount exceeds the supported exact range');
  return number;
}
export function assertStudentFinanceAccess(ctx:RequestContext){if(!['owner','admin','tutor'].includes(ctx.role))throw new ForbiddenException('Student finance requires staff access');assertPermission(ctx,'billing.read');assertPermission(ctx,'reporting.financial');}
const mergeSchema = z.object({ sourceId: z.uuid(), targetId: z.uuid(), revision: z.number().int().positive() });

@Injectable()
export class StudentFinanceService implements OnModuleInit {
  constructor(@Inject(Database) private readonly db: Database, @Inject(EventBus) private readonly bus: EventBus) {}
  onModuleInit() {
    this.bus.subscribe('clients.student-merged.v1', async (event, tx) => {
      if(event.producer!=='clients')throw new Error('student_merge_producer_invalid');
      const merge = parseBody(mergeSchema, event.data);
      if (merge.sourceId === merge.targetId) throw new Error('Invalid merge');
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`monthly:${event.businessId}`]);
      const existing = await tx.query('SELECT target_id FROM billing_student_aliases WHERE source_id=$1', [merge.sourceId]);
      if (existing.rows[0] && existing.rows[0].target_id !== merge.targetId) throw new Error('Conflicting merge');
      const target = (await tx.query('SELECT billing_student_root($1) id', [merge.targetId])).rows[0].id;
      if (target === merge.sourceId) throw new Error('Merge cycle');
      await tx.query('INSERT INTO billing_student_aliases(business_id,source_id,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [event.businessId, merge.sourceId, merge.targetId]);
      await tx.query('UPDATE billing_classes SET client_id=billing_student_root(client_id) WHERE client_id IS DISTINCT FROM billing_student_root(client_id)');
      // Keep the survivor rate. An alias rate is retained but disabled for review;
      // silently choosing a different price could change the next invoice.
      await tx.query('UPDATE student_rates SET active=false,updated_at=now() WHERE client_id<>billing_student_root(client_id) AND active');
    });
  }
  async finance(ctx: RequestContext, query: unknown) {
    assertStudentFinanceAccess(ctx);const input=parseBody(querySchema,query);assertStudentAccess(ctx,input.studentId);
    await this.db.withTenant(ctx.businessId,async tx=>{if(await reconciliationNeedsProjection(tx,ctx.businessId))await ensureReconciliation(tx,ctx.businessId);});
    return this.db.withTenant(ctx.businessId,async tx=>{
      const studentId=(await tx.query('SELECT billing_student_root($1) id',[input.studentId])).rows[0].id;assertStudentAccess(ctx,studentId);
      // Every financial relation is narrowed by reviewed beneficiaries in SQL.
      // Shared obligations retain their full face and settlement amounts.
      const cte=`WITH ${reconciliationClaimsCte}, scoped AS MATERIALIZED (
        SELECT i.*,(SELECT count(DISTINCT billing_student_root(b.student_id)) FROM reconciliation_beneficiaries b WHERE b.business_id=i.business_id AND b.invoice_id=i.id) beneficiary_count
        FROM reconciliation_invoice_claims i WHERE i.business_id=$1 AND i.status<>'draft'
          AND EXISTS(SELECT 1 FROM reconciliation_beneficiaries b WHERE b.business_id=i.business_id AND b.invoice_id=i.id AND billing_student_root(b.student_id)=$2)
      ), balances AS (
        SELECT i.*,i.payable_minor payable,i.recorded_paid_minor recorded_paid,i.verified_paid_minor verified_paid,
          i.balance_minor outstanding,i.credit_minor credit,i.refund_minor refund,i.historical_paid_minor historical
        FROM scoped i
      ), payments AS (
        SELECT r.id::text || ':' || a.invoice_id::text id,a.invoice_id,sum(a.amount_minor) amount_minor,a.currency,r.provider,r.evidence,false simulated,r.paid_at created_at,
          coalesce((SELECT sum(j.amount_minor) FROM reconciliation_adjustments j WHERE j.business_id=a.business_id AND j.invoice_id=a.invoice_id AND j.receipt_id=a.receipt_id AND j.kind='refund'),0) refunded_minor,i.beneficiary_count
        FROM reconciliation_allocations a JOIN scoped i ON i.business_id=a.business_id AND i.id=a.invoice_id JOIN reconciliation_receipts r ON r.business_id=a.business_id AND r.id=a.receipt_id WHERE r.evidence<>'simulated' GROUP BY a.business_id,a.invoice_id,a.receipt_id,a.currency,r.id,r.provider,r.evidence,r.paid_at,i.beneficiary_count
        UNION ALL SELECT p.payment_id::text,s.invoice_id,p.amount_minor,p.currency,p.provider,'simulated',true,p.created_at,0::bigint,i.beneficiary_count
        FROM payment_allocations p JOIN reconciliation_source_aliases s ON s.business_id=p.business_id AND s.kind='native' AND s.source_id=p.invoice_id JOIN scoped i ON i.business_id=s.business_id AND i.id=s.invoice_id WHERE p.simulated
      )`;
      const values=[ctx.businessId,studentId,input.limit,input.offset];
      const selected=await tx.query(`${cte} SELECT * FROM balances ORDER BY invoice_date DESC,id LIMIT $3 OFFSET $4`,values);
      const count=(await tx.query(`${cte} SELECT count(*) total FROM scoped`,values.slice(0,2))).rows[0];
      const paymentRows=await tx.query(`${cte} SELECT * FROM payments ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,values);
      const paymentCount=(await tx.query(`${cte} SELECT count(*) total FROM payments`,values.slice(0,2))).rows[0];
      const totals=await tx.query(`${cte} SELECT b.currency,sum(b.face_minor) face,sum(b.payable) billed,sum(b.recorded_paid) recorded,sum(b.verified_paid) verified,
        sum(b.historical) historical,sum(b.outstanding) outstanding,sum(b.credit) credits,sum(b.refund) refunds,
        count(*) FILTER(WHERE b.beneficiary_count>1) shared_invoices,
        coalesce((SELECT sum(p.amount_minor) FROM payments p WHERE p.currency=b.currency AND p.simulated),0) simulated
        FROM balances b GROUP BY b.currency ORDER BY b.currency`,values.slice(0,2));
      return {studentId,items:selected.rows.map(row=>{
        const snapshot=row.source_snapshot??{};return {id:row.id,origin:row.origin_kind,sourceId:row.origin_id,invoiceNumber:snapshot.invoice_number??null,payerName:snapshot.payer_name??snapshot.student_name??'',currency:row.currency,
          totalMinor:safeAmount(row.face_minor),payableMinor:safeAmount(row.payable),paidMinor:safeAmount(row.recorded_paid),verifiedMinor:safeAmount(row.verified_paid),historicalMinor:safeAmount(row.historical),outstandingMinor:safeAmount(row.outstanding),creditMinor:safeAmount(row.credit),refundMinor:safeAmount(row.refund),
          status:safeAmount(row.outstanding)===0?'settled':'issued',issuedAt:dayView(row.invoice_date),dueAt:row.due_date?dayView(row.due_date):null,serviceMonth:row.service_month?dayView(row.service_month).slice(0,7):null,items:Array.isArray(snapshot.items)?snapshot.items:[],revision:row.revision,studentId,beneficiaryCount:safeAmount(row.beneficiary_count),sharedFamilyInvoice:safeAmount(row.beneficiary_count)>1};
      }),total:safeAmount(count.total),payments:paymentRows.rows.map(row=>({id:row.id,invoiceId:row.invoice_id,amountMinor:safeAmount(row.amount_minor),currency:row.currency,provider:row.provider,evidence:row.evidence,simulated:row.simulated,refundedMinor:safeAmount(row.refunded_minor),createdAt:row.created_at,sharedFamilyInvoice:safeAmount(row.beneficiary_count)>1})),paymentTotal:safeAmount(paymentCount.total),limit:input.limit,offset:input.offset,
        totals:totals.rows.map(row=>({currency:row.currency,faceMinor:safeAmount(row.face),billedMinor:safeAmount(row.billed),recordedPaidMinor:safeAmount(row.recorded),collectedMinor:safeAmount(row.verified),historicalPaidMinor:safeAmount(row.historical),simulatedMinor:safeAmount(row.simulated),outstandingMinor:safeAmount(row.outstanding),creditMinor:safeAmount(row.credits),refundMinor:safeAmount(row.refunds),sharedInvoices:safeAmount(row.shared_invoices)})),
        asOf:new Date().toISOString(),coverage:'reviewed_beneficiary_invoices_and_settlement_evidence',sharedInvoicePolicy:'Shared family invoices show the complete obligation for every beneficiary; amounts are not divided between students.'};
    },{isolation:'repeatable read'});
  }

}

@Controller('v1/portal/finance')
@Roles('owner', 'admin', 'tutor')
@StudentScoped()
@Permissions('billing.read','reporting.financial')
export class StudentFinanceController {
  constructor(@Inject(StudentFinanceService) private readonly service: StudentFinanceService) {}
  @Get() get(@CurrentContext() ctx: RequestContext, @Query() query: unknown) { return this.service.finance(ctx, query); }
}
