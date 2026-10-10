import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Database, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { assertHistoryAccess, safeHistoryMinor } from './history.js';
import { localDate, monthSchema, previousMonth } from './monthly.js';

const querySchema=z.object({month:monthSchema.optional()}).strict();
const number=(value:unknown)=>{const n=Number(value);if(!Number.isFinite(n)||n<0)throw new UnprocessableEntityException('Aggregate exceeds the supported numeric range');return n;};
@Injectable()
export class HistoryAnalyticsService {
  constructor(@Inject(Database) private readonly db:Database){}
  async analytics(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(querySchema,query);
    return this.db.withTenant(ctx.businessId,async tx=>{
      const timeZone=(await tx.query('SELECT time_zone FROM billing_settings LIMIT 1')).rows[0]?.time_zone??'UTC';
      const asOf=new Date(),currentMonth=localDate(asOf,timeZone).month,month=input.month??currentMonth,previous=previousMonth(month);
      const counts=(await tx.query(`SELECT (SELECT count(*) FROM billing_work_log) work_rows,(SELECT count(*) FROM billing_invoice_history) imported_invoices,(SELECT count(*) FROM invoices) native_invoices,(SELECT count(*) FROM billing_classes WHERE status='completed' AND NOT reconciliation_missing) confirmed_classes,(SELECT count(*) FROM billing_history_sources) source_files`)).rows[0];
      const workRows=Number(counts.work_rows),nativeClasses=Number(counts.confirmed_classes),useWork=workRows>0,hasActivity=useWork||nativeClasses>0;
      // Unlinked names and native student IDs cannot safely be merged. Use one observed
      // activity source for hour/student measures instead of adding overlapping ledgers.
      const activity=useWork?`SELECT student_name student,work_date date,hours,count_as_classes is_class FROM billing_work_log`:`SELECT billing_student_root(client_id)::text student,(starts_at AT TIME ZONE $3)::date date,extract(epoch FROM (ends_at-starts_at))/3600 hours,true is_class FROM billing_classes WHERE status='completed' AND NOT reconciliation_missing`;
      const summary=(await tx.query(`WITH activity AS (${activity}), seen AS (SELECT DISTINCT student FROM activity WHERE student IS NOT NULL AND date>= $1::date AND date<($1::date+INTERVAL '1 month')), prior AS (SELECT DISTINCT student FROM activity WHERE student IS NOT NULL AND date>=$2::date AND date<($2::date+INTERVAL '1 month')) SELECT (SELECT count(*) FROM activity WHERE student IS NULL) missing_identity,(SELECT count(DISTINCT student) FROM activity) tracked,(SELECT count(*) FROM seen) active,(SELECT count(*) FROM prior) previous,(SELECT count(*) FROM prior p WHERE NOT EXISTS(SELECT 1 FROM seen s WHERE s.student=p.student)) lost,(SELECT COALESCE(sum(hours),0) FROM activity) total_hours,(SELECT COALESCE(sum(hours),0) FROM activity WHERE date>=$1::date AND date<($1::date+INTERVAL '1 month')) month_hours,(SELECT count(*) FROM activity WHERE is_class AND date>=$1::date AND date<($1::date+INTERVAL '1 month')) classes,(SELECT count(DISTINCT student) FROM activity WHERE is_class AND date>=$1::date AND date<($1::date+INTERVAL '1 month')) class_students`,useWork?[`${month}-01`,`${previous}-01`]:[`${month}-01`,`${previous}-01`,timeZone])).rows[0];
      const trend=(await tx.query(`WITH activity AS (${useWork?activity:activity.replace('$3','$1')}) SELECT to_char(date,'YYYY-MM') AS month,sum(hours) hours,CASE WHEN count(*) FILTER(WHERE student IS NULL)>0 THEN NULL ELSE count(DISTINCT student) END active_students,count(*) FILTER(WHERE is_class) classes FROM activity WHERE date>=DATE '2000-01-01' AND date<DATE '2201-01-01' GROUP BY to_char(date,'YYYY-MM') ORDER BY month`,useWork?[]:[timeZone])).rows;
      const financial=(await tx.query(`WITH currencies AS (SELECT currency FROM billing_work_log UNION SELECT currency FROM billing_invoice_history UNION SELECT currency FROM invoices UNION SELECT currency FROM student_rates WHERE active), ledger AS (
        SELECT currency,count(*) n,sum(amount_minor) total,COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0) paid,COALESCE(sum(amount_minor) FILTER(WHERE status='pending'),0) pending,COALESCE(sum(amount_minor) FILTER(WHERE status='unsent'),0) unsent,COALESCE(sum(amount_minor) FILTER(WHERE work_date>=$1::date AND work_date<($1::date+INTERVAL '1 month')),0) month_total FROM billing_work_log GROUP BY currency
      ), historical AS (
        SELECT currency,count(*) n,COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0) paid,COALESCE(sum(amount_minor) FILTER(WHERE status='pending'),0) pending,COALESCE(sum(amount_minor) FILTER(WHERE status='unsent'),0) unsent FROM billing_invoice_history GROUP BY currency
      ), balances AS (
        SELECT i.id,i.currency,i.total_minor,i.status,COALESCE(sum(p.amount_minor) FILTER(WHERE NOT p.simulated),0) real_paid FROM invoices i LEFT JOIN payment_allocations p ON p.business_id=i.business_id AND p.invoice_id=i.id GROUP BY i.id
      ), native AS (
        SELECT currency,count(*) n,sum(real_paid) paid,COALESCE(sum(greatest(total_minor-real_paid,0)) FILTER(WHERE status<>'draft'),0) pending,COALESCE(sum(total_minor) FILTER(WHERE status='draft'),0) unsent FROM balances GROUP BY currency
      ), expected AS (
        SELECT r.currency,sum(r.unit_price_minor) total FROM billing_classes c JOIN student_rates r ON r.client_id=billing_student_root(c.client_id) AND r.business_id=c.business_id AND r.active WHERE NOT c.reconciliation_missing AND c.status IN ('scheduled','completed') AND (c.starts_at AT TIME ZONE $2)::date>=$1::date AND (c.starts_at AT TIME ZONE $2)::date<($1::date+INTERVAL '1 month') GROUP BY r.currency
      ) SELECT c.currency,l.n ledger_n,l.total ledger_total,l.paid ledger_paid,l.pending ledger_pending,l.unsent ledger_unsent,l.month_total ledger_month,h.n historical_n,h.paid historical_paid,h.pending historical_pending,h.unsent historical_unsent,n.n native_n,n.paid native_paid,n.pending native_pending,n.unsent native_unsent,e.total native_expected FROM currencies c LEFT JOIN ledger l ON l.currency=c.currency LEFT JOIN historical h ON h.currency=c.currency LEFT JOIN native n ON n.currency=c.currency LEFT JOIN expected e ON e.currency=c.currency ORDER BY c.currency`,[`${month}-01`,timeZone])).rows;
      const currencyItems=financial.map(row=>{
        const hasInvoices=Number(row.historical_n??0)+Number(row.native_n??0)>0,hasLedger=Number(row.ledger_n??0)>0;
        const sum=(a:unknown,b:unknown)=>safeHistoryMinor((BigInt(String(a??0))+BigInt(String(b??0))).toString());
        const historicalPaidMinor=hasInvoices?safeHistoryMinor(row.historical_paid??0):null,verifiedCollectedMinor=hasInvoices?safeHistoryMinor(row.native_paid??0):null;
        return {currency:row.currency,totalRecordedRevenueMinor:hasInvoices?sum(row.historical_paid,row.native_paid):null,historicalPaidMinor,verifiedCollectedMinor,pendingMinor:hasInvoices?sum(row.historical_pending,row.native_pending):null,unsentMinor:hasInvoices?sum(row.historical_unsent,row.native_unsent):null,expectedThisMonthMinor:hasLedger?safeHistoryMinor(row.ledger_month):null,ledgerTotalMinor:hasLedger?safeHistoryMinor(row.ledger_total):null,ledgerPaidMinor:hasLedger?safeHistoryMinor(row.ledger_paid):null,ledgerPendingMinor:hasLedger?safeHistoryMinor(row.ledger_pending):null,ledgerUnsentMinor:hasLedger?safeHistoryMinor(row.ledger_unsent):null,ledgerMonthMinor:hasLedger?safeHistoryMinor(row.ledger_month):null,nativeExpectedMinor:row.native_expected===null?null:safeHistoryMinor(row.native_expected)};
      });
      const hasIdentity=hasActivity&&Number(summary.missing_identity)===0;
      const active=Number(summary.active),previousActive=Number(summary.previous),classStudents=Number(summary.class_students);
      const notes=[
        'Recorded revenue is real native payment allocations plus imported invoice paid declarations; work ledger amounts are separate.',
        'Paid work and invoice declarations are historical assertions, not processor-verified payments.',
        'Expected monthly value uses recorded work only; native class estimates are separate and are not added.',
        'Student identity uses one activity source: exact imported names when work exists, otherwise native student IDs. No contact merge is inferred.',
        useWork?'Hours, trends and activity counts use imported work; overlapping native classes are not added.':'Hours, trends and activity counts use completed native classes.',
        'Invoice sources require reviewed identifiers; records without invoice numbers cannot be automatically reconciled to native invoices.',
        'Churn measures inactivity relative to the previous month and is provisional until the selected month ends.',
      ];
      if(!hasIdentity&&hasActivity)notes.push('Student metrics are unknown while completed classes lack a linked native student ID.');
      if(useWork&&!classStudents)notes.push('Work rows are not classified as classes by default; class frequency is unknown until reviewed.');
      return {month,timeZone,asOf:asOf.toISOString(),students:{tracked:hasIdentity?Number(summary.tracked):null,activeThisMonth:hasIdentity?active:null,activePreviousMonth:hasIdentity?previousActive:null,lostFromPreviousMonth:hasIdentity?Number(summary.lost):null},engagement:{totalHours:hasActivity?number(summary.total_hours):null,monthHours:hasActivity?number(summary.month_hours):null,averageCommitmentHours:hasIdentity&&active?number(summary.month_hours)/active:null,averageClassFrequency:hasIdentity&&classStudents?Number(summary.classes)/classStudents:null,churnRate:hasIdentity&&previousActive?Number(summary.lost)/previousActive:null},currencies:currencyItems,trend:trend.map(row=>({month:row.month,hours:number(row.hours),activeStudents:row.active_students===null?null:Number(row.active_students),classes:useWork&&Number(row.classes)===0?null:Number(row.classes)})),coverage:{workRows,importedInvoices:Number(counts.imported_invoices),nativeInvoices:Number(counts.native_invoices),confirmedClasses:nativeClasses,sourceFiles:Number(counts.source_files),studentIdentity:'unlinked_source_names_and_native_student_ids',payments:'verified_allocations_excluding_simulated',churn:'inactivity',provisional:month>=currentMonth,notes}};
    });
  }
}
