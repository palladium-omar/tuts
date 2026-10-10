import { ConflictException } from '@nestjs/common';
import type { RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { authorizedRoot, type Coverage } from '../src/reporting.service.js';
import type { Period } from '../src/schemas.js';
const safeCount=(value:unknown)=>{const n=Number(value??0);if(!Number.isSafeInteger(n)||n<0)throw new ConflictException('Report aggregate exceeds supported numeric range');return n;};
// Frozen pre-batching behavior used only for PostgreSQL regression comparison.
export async function legacySummary(tx: PoolClient, ctx: RequestContext, id: string, period: Period, financial: boolean) {
        const studentId = await authorizedRoot(tx, ctx, id), { month, timeZone } = period;
        const observed = await tx.query<{
            scheduling: Date | null;
            learning: Date | null;
            resources: Date | null;
        }>(`SELECT (SELECT max(observed_at) FROM report_classes WHERE student_id=$1) scheduling,(SELECT max(observed_at) FROM report_assignments WHERE student_id=$1) learning,(SELECT max(observed_at) FROM report_resources WHERE student_id=$1) resources`, [studentId]);
        const stored = await tx.query<{
            source: string;
            status: Coverage['status'];
            as_of: Date | null;
            reason: string | null;
        }>(`SELECT * FROM report_coverage WHERE student_id=$1 AND month=$2 AND time_zone=$3 AND source=ANY($4::text[])`, [studentId, month, timeZone, financial ? ['scheduling', 'learning', 'billing'] : ['scheduling', 'learning']]);
        const sourceCoverage = (source: string, seen: Date | null): Coverage => {
            const row = stored.rows.find(r => r.source === source);
            if (row)
                return {
                    status: row.status, asOf: [row.as_of?.toISOString(), seen?.toISOString()].filter((v): v is string => Boolean(v)).sort().at(-1) ?? null, ...row.reason ? {
                        reason: row.reason
                    } : {}
                };
            return seen ? {
                status: 'partial', asOf: seen.toISOString(), reason: 'Observed events only; historical coverage has not been reconciled'
            } : {
                status: 'missing', asOf: null, reason: 'No reconciled history or source events yet'
            };
        };
        const coverage: {
            scheduling: Coverage;
            learning: Coverage;
            billing?: Coverage;
        } = {
            scheduling: sourceCoverage('scheduling', observed.rows[0]!.scheduling), learning: sourceCoverage('learning', observed.rows[0]!.learning ?? observed.rows[0]!.resources)
        };
        const undated = await tx.query('SELECT 1 FROM report_assignments WHERE student_id=$1 AND due_at IS NULL AND created_at IS NULL LIMIT 1', [studentId]);
        if (undated.rowCount && coverage.learning.status === 'complete')
            coverage.learning = {
                ...coverage.learning, status: 'partial', reason: 'Some homework dates are unknown; reconcile source history'
            };
        const classes = await tx.query<{
            booked: string;
            completed: string;
            cancelled: string;
            no_show: string;
        }>(`SELECT count(*) FILTER(WHERE status='scheduled') booked,count(*) FILTER(WHERE status='completed') completed,count(*) FILTER(WHERE status='cancelled') cancelled,count(*) FILTER(WHERE status='no_show') no_show FROM report_classes WHERE student_id=$1 AND (starts_at AT TIME ZONE $2)::date>=($3||'-01')::date AND (starts_at AT TIME ZONE $2)::date<(($3||'-01')::date+interval '1 month')`, [studentId, timeZone, month]);
        const homework = await tx.query<{
            assigned: string;
            submitted: string;
            completed: string;
            needs_revision: string;
        }>(`SELECT count(*) FILTER(WHERE status='assigned') assigned,count(*) FILTER(WHERE status='submitted') submitted,count(*) FILTER(WHERE status='completed') completed,count(*) FILTER(WHERE status='needs_revision') needs_revision FROM report_assignments WHERE student_id=$1 AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date>=($3||'-01')::date AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date<(($3||'-01')::date+interval '1 month')`, [studentId, timeZone, month]);
        const activity = await tx.query<{
            active_seconds: string;
            last_seen: Date | null;
        }>(`SELECT coalesce(sum(accepted_seconds) FILTER(WHERE (received_at AT TIME ZONE $2)::date>=($3||'-01')::date AND (received_at AT TIME ZONE $2)::date<(($3||'-01')::date+interval '1 month')),0)::text active_seconds,max(received_at) last_seen FROM activity_receipts WHERE student_id=$1`, [studentId, timeZone, month]);
        const resources = await tx.query<{
            materials: string;
            submission_files: string;
        }>(`SELECT count(*) FILTER(WHERE assignment_id IS NULL) materials,count(*) FILTER(WHERE assignment_id IS NOT NULL) submission_files FROM report_resources WHERE student_id=$1`, [studentId]);
        const observedCounts = (source: Coverage, value: unknown) => source.status === 'missing' || (source.status === 'unavailable' && !source.asOf) ? null : safeCount(value);
        let finance: undefined | {
            period: 'all_time';
            totalsByCurrency: unknown[] | null;
            issuedInvoiceCount: number | null;
            asOf: string | null;
        };
        if (financial) {
            const rows = await tx.query<{
                totals: unknown[];
                invoice_count: number;
                as_of: Date;
                complete: boolean;
            }>('SELECT * FROM report_finance_snapshots WHERE student_id=$1', [studentId]);
            const snapshot = rows.rows[0];
            coverage.billing = snapshot?.complete ? {
                status: 'complete', asOf: snapshot.as_of.toISOString()
            } : sourceCoverage('billing', snapshot?.as_of ?? null);
            finance = {
                period: 'all_time', totalsByCurrency: snapshot?.complete ? snapshot.totals : null, issuedInvoiceCount: snapshot?.complete ? snapshot.invoice_count : null, asOf: snapshot?.as_of.toISOString() ?? null
            };
        }
        const asOf = [coverage.scheduling.asOf, coverage.learning.asOf, coverage.billing?.asOf, activity.rows[0]!.last_seen?.toISOString()].filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
        return {
            studentId, month, timeZone, bookings: {
                booked: observedCounts(coverage.scheduling, classes.rows[0]!.booked), completed: observedCounts(coverage.scheduling, classes.rows[0]!.completed), cancelled: observedCounts(coverage.scheduling, classes.rows[0]!.cancelled), noShow: observedCounts(coverage.scheduling, classes.rows[0]!.no_show)
            }, homework: {
                assigned: observedCounts(coverage.learning, homework.rows[0]!.assigned), submitted: observedCounts(coverage.learning, homework.rows[0]!.submitted), completed: observedCounts(coverage.learning, homework.rows[0]!.completed), needsRevision: observedCounts(coverage.learning, homework.rows[0]!.needs_revision)
            }, resources: {
                period: 'all_time' as const, materials: observedCounts(coverage.learning, resources.rows[0]!.materials), submissionFiles: observedCounts(coverage.learning, resources.rows[0]!.submission_files)
            }, activity: {
                activeSeconds: safeCount(activity.rows[0]!.active_seconds), lastSeenAt: activity.rows[0]!.last_seen?.toISOString() ?? null, estimated: true as const, scope: 'tuts' as const
            }, ...finance ? {
                financial: finance
            } : {}, coverage, asOf, partial: Object.values(coverage).some(c => c.status !== 'complete')
        };
    }
