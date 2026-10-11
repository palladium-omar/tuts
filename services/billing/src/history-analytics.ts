import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Database, logDiagnostic, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { assertHistoryAccess, safeHistoryMinor } from './history.js';
import { localDate, monthSchema, previousMonth } from './monthly.js';
import { ensureReconciliation, reconciliationNeedsProjection, reconciliationTotals } from './reconciliation-engine.js';

const querySchema=z.object({month:monthSchema.optional()}).strict();
const number=(value:unknown)=>{const n=Number(value);if(!Number.isFinite(n)||n<0||n>Number.MAX_SAFE_INTEGER)throw new UnprocessableEntityException('Aggregate exceeds the supported numeric range');return n;};
@Injectable()
export class HistoryAnalyticsService {
  constructor(@Inject(Database) private readonly db:Database){}
  async analytics(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(querySchema,query);
    const started=Date.now();
    await this.db.withTenant(ctx.businessId,async tx=>{if(await reconciliationNeedsProjection(tx,ctx.businessId))await ensureReconciliation(tx,ctx.businessId);});
    const result=await this.db.withTenant(ctx.businessId,async tx=>{
      // Keep counts, activity and money on one stable snapshot during imports/payments.
      const timeZone=(await tx.query('SELECT time_zone FROM billing_settings LIMIT 1')).rows[0]?.time_zone??'UTC';
      const asOf=new Date(),currentMonth=localDate(asOf,timeZone).month,month=input.month??currentMonth,previous=previousMonth(month);
      const counts=(await tx.query(`SELECT (SELECT count(*) FROM billing_work_log) work_rows,(SELECT count(*) FROM billing_invoice_history) imported_invoices,(SELECT count(*) FROM invoices) native_invoices,(SELECT count(*) FROM billing_classes WHERE status='completed' AND NOT reconciliation_missing) confirmed_classes,(SELECT count(*) FROM billing_history_sources) source_files`)).rows[0];
      const workRows=safeHistoryMinor(counts.work_rows),nativeClasses=safeHistoryMinor(counts.confirmed_classes),useWork=workRows>0,hasActivity=useWork||nativeClasses>0;
      // Unlinked names and native student IDs cannot safely be merged. Use one observed
      // activity source for hour/student measures instead of adding overlapping ledgers.
      const activity=useWork?`SELECT CASE WHEN i.status='linked' AND i.work_revision=w.revision THEN billing_student_root(i.student_id)::text END student,w.work_date date,w.hours,w.count_as_classes is_class FROM billing_work_log w LEFT JOIN billing_work_identities i ON i.business_id=w.business_id AND i.work_id=w.id`:`SELECT billing_student_root(client_id)::text student,(starts_at AT TIME ZONE $3)::date date,extract(epoch FROM (ends_at-starts_at))/3600 hours,true is_class FROM billing_classes WHERE status='completed' AND NOT reconciliation_missing`;
      const summary=(await tx.query(`WITH activity AS (${activity}), seen AS (SELECT DISTINCT student FROM activity WHERE student IS NOT NULL AND date>= $1::date AND date<($1::date+INTERVAL '1 month')), prior AS (SELECT DISTINCT student FROM activity WHERE student IS NOT NULL AND date>=$2::date AND date<($2::date+INTERVAL '1 month')) SELECT (SELECT count(*) FROM activity WHERE student IS NULL) missing_identity,(SELECT count(DISTINCT student) FROM activity) tracked,(SELECT count(*) FROM seen) active,(SELECT count(*) FROM prior) previous,(SELECT count(*) FROM prior p WHERE NOT EXISTS(SELECT 1 FROM seen s WHERE s.student=p.student)) lost,(SELECT COALESCE(sum(hours),0) FROM activity) total_hours,(SELECT COALESCE(sum(hours),0) FROM activity WHERE date>=$1::date AND date<($1::date+INTERVAL '1 month')) month_hours,(SELECT count(*) FROM activity WHERE is_class AND date>=$1::date AND date<($1::date+INTERVAL '1 month')) classes,(SELECT count(DISTINCT student) FROM activity WHERE is_class AND date>=$1::date AND date<($1::date+INTERVAL '1 month')) class_students,(SELECT COALESCE(json_agg(t ORDER BY t.month),'[]'::json) FROM (SELECT to_char(date,'YYYY-MM') AS month,sum(hours) hours,CASE WHEN count(*) FILTER(WHERE student IS NULL)>0 THEN NULL ELSE count(DISTINCT student) END active_students,count(*) FILTER(WHERE is_class) classes FROM activity WHERE date>=DATE '2000-01-01' AND date<DATE '2201-01-01' GROUP BY to_char(date,'YYYY-MM')) t) trend`,useWork?[`${month}-01`,`${previous}-01`]:[`${month}-01`,`${previous}-01`,timeZone])).rows[0];
      const trend: Array<{month:string;hours:unknown;active_students:unknown;classes:unknown}> = summary.trend;
      const financial=(await tx.query(`WITH currencies AS (SELECT currency FROM billing_work_log UNION SELECT currency FROM billing_invoice_history UNION SELECT currency FROM invoices UNION SELECT currency FROM student_rates WHERE active), ledger AS (
        SELECT currency,count(*) n,sum(amount_minor) total,COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0) paid,COALESCE(sum(amount_minor) FILTER(WHERE status='pending'),0) pending,COALESCE(sum(amount_minor) FILTER(WHERE status='unsent'),0) unsent,COALESCE(sum(amount_minor) FILTER(WHERE work_date>=$1::date AND work_date<($1::date+INTERVAL '1 month')),0) month_total FROM billing_work_log GROUP BY currency
      ), expected AS (
        SELECT r.currency,sum(r.unit_price_minor) total FROM billing_classes c JOIN student_rates r ON r.client_id=billing_student_root(c.client_id) AND r.business_id=c.business_id AND r.active WHERE NOT c.reconciliation_missing AND c.status IN ('scheduled','completed') AND c.starts_at>=($1::date::timestamp AT TIME ZONE $2) AND c.starts_at<(($1::date+INTERVAL '1 month')::timestamp AT TIME ZONE $2) GROUP BY r.currency
      ) SELECT c.currency,l.n ledger_n,l.total ledger_total,l.paid ledger_paid,l.pending ledger_pending,l.unsent ledger_unsent,l.month_total ledger_month,e.total native_expected FROM currencies c LEFT JOIN ledger l ON l.currency=c.currency LEFT JOIN expected e ON e.currency=c.currency ORDER BY c.currency`,[`${month}-01`,timeZone])).rows;
      const totals=await reconciliationTotals(tx,ctx.businessId);
      const financialByCurrency=new Map(financial.map(row=>[row.currency,row]));
      const totalByCurrency=new Map(totals.map(row=>[row.currency,row]));
      const currencyItems=[...new Set([...financialByCurrency.keys(),...totalByCurrency.keys()])].sort().map(currency=>{
        const row=financialByCurrency.get(currency),measure=totalByCurrency.get(currency),hasLedger=Number(row?.ledger_n??0)>0;
        return {currency,totalRecordedRevenueMinor:measure?.recordedPaidMinor??0,historicalPaidMinor:measure?.historicalPaidMinor??0,verifiedCollectedMinor:measure?.verifiedReceivedMinor??0,pendingMinor:measure?.pendingMinor??0,unsentMinor:measure?.unsentMinor??0,
          invoicedMinor:measure?.invoicedMinor??0,outstandingMinor:measure?.outstandingMinor??0,unresolvedInvoices:measure?.unresolvedInvoices??0,unallocatedReceipts:measure?.unallocatedReceipts??0,staleCoverage:(measure?.staleWorkLinks??0)+(measure?.staleSources??0),
          expectedThisMonthMinor:hasLedger?safeHistoryMinor(row!.ledger_month):null,ledgerTotalMinor:hasLedger?safeHistoryMinor(row!.ledger_total):null,ledgerPaidMinor:hasLedger?safeHistoryMinor(row!.ledger_paid):null,ledgerPendingMinor:hasLedger?safeHistoryMinor(row!.ledger_pending):null,ledgerUnsentMinor:hasLedger?safeHistoryMinor(row!.ledger_unsent):null,ledgerMonthMinor:hasLedger?safeHistoryMinor(row!.ledger_month):null,nativeExpectedMinor:row?.native_expected==null?null:safeHistoryMinor(row.native_expected)};
      });
      const hasIdentity=hasActivity&&safeHistoryMinor(summary.missing_identity)===0;
      const active=safeHistoryMinor(summary.active),previousActive=safeHistoryMinor(summary.previous),classStudents=safeHistoryMinor(summary.class_students);
      const notes=[
        'Recorded paid combines uncovered paid work with distinct accepted invoice settlements. Overlapping receipts replace historical declarations instead of adding a second contribution.',
        'Paid work and invoice declarations are historical assertions, not processor-verified payments.',
        'Expected monthly value uses recorded work only; native class estimates are separate and are not added.',
        'Student identity uses canonical native IDs and explicit reviewed work-row associations. Imported names never establish a unique person; unreviewed, ambiguous or stale rows keep student metrics unknown.',
        useWork?'Hours, trends and activity counts use imported work; overlapping native classes are not added.':'Hours, trends and activity counts use completed native classes.',
        'Imported invoice evidence contributes to totals only after review. Unresolved documents, unallocated receipts and stale relationships require attention.',
        'Churn measures inactivity relative to the previous month and is provisional until the selected month ends.',
      ];
      if(!hasIdentity&&hasActivity)notes.push(useWork?'Student metrics are unknown while imported work rows have unreviewed, ambiguous or stale canonical associations.':'Student metrics are unknown while completed classes lack a linked native student ID.');
      if(useWork&&!classStudents)notes.push('Work rows are not classified as classes by default; class frequency is unknown until reviewed.');
      return {month,timeZone,asOf:asOf.toISOString(),students:{tracked:hasIdentity?safeHistoryMinor(summary.tracked):null,activeThisMonth:hasIdentity?active:null,activePreviousMonth:hasIdentity?previousActive:null,lostFromPreviousMonth:hasIdentity?safeHistoryMinor(summary.lost):null},engagement:{totalHours:hasActivity?number(summary.total_hours):null,monthHours:hasActivity?number(summary.month_hours):null,averageCommitmentHours:hasIdentity&&active?number(summary.month_hours)/active:null,averageClassFrequency:hasIdentity&&classStudents?safeHistoryMinor(summary.classes)/classStudents:null,churnRate:hasIdentity&&previousActive?safeHistoryMinor(summary.lost)/previousActive:null},currencies:currencyItems,trend:trend.map(row=>({month:row.month,hours:number(row.hours),activeStudents:row.active_students===null?null:safeHistoryMinor(row.active_students),classes:useWork&&safeHistoryMinor(row.classes)===0?null:safeHistoryMinor(row.classes)})),coverage:{workRows,importedInvoices:safeHistoryMinor(counts.imported_invoices),nativeInvoices:safeHistoryMinor(counts.native_invoices),confirmedClasses:nativeClasses,sourceFiles:safeHistoryMinor(counts.source_files),studentIdentity:useWork?(hasIdentity?'reviewed_work_rows_and_native_student_ids':'partial_reviewed_work_identities'):'unlinked_source_names_and_native_student_ids',payments:'distinct_verified_receipts_excluding_simulated',churn:'inactivity',provisional:month>=currentMonth,notes}};
    }, { isolation: 'repeatable read' });
    logDiagnostic('info','target_completed',{target:'billing',view:'dashboard',status:200,durationMs:Date.now()-started});
    return result;
  }
}
