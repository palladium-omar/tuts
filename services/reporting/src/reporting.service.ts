import { ConflictException, ForbiddenException, HttpException, Inject, Injectable } from '@nestjs/common';
import { Database, assertStudentAccess, assertPermission, emitEvent } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { studentRoot, lockReports } from './projections.js';
import type { Period } from './schemas.js';
export function assertFinancial(ctx: RequestContext) {
    assertPermission(ctx, 'billing.read');
    assertPermission(ctx, 'reporting.financial');
    if (!ctx.entitlements.includes('billing'))
        throw new ForbiddenException('Billing is not enabled for this business');
}
export async function authorizedRoot(tx: PoolClient, ctx: RequestContext, id: string) {
    assertStudentAccess(ctx, id);
    const canonical = await studentRoot(tx, id);
    assertStudentAccess(ctx, canonical);
    return canonical;
}
function safeCount(value: unknown): number {
    const n = Number(value ?? 0);
    if (!Number.isSafeInteger(n) || n < 0)
        throw new ConflictException('Report aggregate exceeds supported numeric range');
    return n;
}
export type Coverage = {
    status: 'missing' | 'partial' | 'complete' | 'unavailable';
    asOf: string | null;
    reason?: string;
};
@Injectable()
export class ReportingService {
    constructor(
    @Inject(Database)
    private readonly db: Database) {
    }
    async summaries(ctx: RequestContext, ids: string[], period: Period, financial = false) {
        if (financial)
            assertFinancial(ctx);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockReports(tx, ctx.businessId);
            const items = [];
            for (const id of [...new Set(ids)])
                items.push(await this.summary(tx, ctx, id, period, financial));
            return {
                items, asOf: items.reduce<string | null>((a, b) => b.asOf && (!a || b.asOf > a) ? b.asOf : a, null)
            };
        });
    }
    private async summary(tx: PoolClient, ctx: RequestContext, id: string, period: Period, financial: boolean) {
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
    async activity(ctx: RequestContext, v: {
        studentId: string;
        sessionId: string;
        sequence: number;
        activeSeconds: number;
    }) {
        if (ctx.role !== 'student')
            throw new ForbiddenException('Student activity is recorded only for the student actor');
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockReports(tx, ctx.businessId);
            const studentId = await authorizedRoot(tx, ctx, v.studentId);
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`reporting-activity:${ctx.businessId}:${ctx.sub}`]);
            const previous = await tx.query<{
                student_id: string;
                claimed_seconds: number;
                accepted_seconds: number;
                received_at: Date;
            }>('SELECT * FROM activity_receipts WHERE actor_id=$1 AND session_id=$2 AND sequence=$3', [ctx.sub, v.sessionId, v.sequence]);
            if (previous.rows[0]) {
                const p = previous.rows[0];
                if (p.student_id !== studentId || p.claimed_seconds !== v.activeSeconds)
                    throw new ConflictException('Activity sequence was already used with different content');
                return {
                    item: {
                        acceptedSeconds: p.accepted_seconds, duplicate: true, lastSeenAt: p.received_at.toISOString()
                    }
                };
            }
            const clock = await tx.query<{
                now: Date;
            }>('SELECT clock_timestamp() now');
            const now = clock.rows[0]!.now;
            const session = await tx.query<{
                last_sequence: number;
                last_received_at: Date;
            }>('SELECT * FROM activity_sessions WHERE actor_id=$1 AND session_id=$2', [ctx.sub, v.sessionId]);
            const cursor = await tx.query<{
                last_received_at: Date;
            }>('SELECT * FROM activity_actor_cursors WHERE actor_id=$1', [ctx.sub]);
            const old = session.rows[0], actor = cursor.rows[0];
            let acceptedSeconds = 0;
            const stale = Boolean(old && v.sequence <= old.last_sequence);
            const sessionGap = old ? (now.getTime() - old.last_received_at.getTime()) / 1000 : 0, actorGap = actor ? (now.getTime() - actor.last_received_at.getTime()) / 1000 : 0;
            if (!stale && actor && actorGap < 5)
                throw new HttpException('Activity heartbeats are limited to one per actor every five seconds', 429);
            if (!stale && old && actor && sessionGap >= 5 && sessionGap <= 60 && actorGap >= 5 && actorGap <= 60)
                acceptedSeconds = Math.max(0, Math.min(v.activeSeconds, 30, Math.floor(sessionGap), Math.floor(actorGap)));
            await tx.query('INSERT INTO activity_receipts(business_id,actor_id,session_id,sequence,student_id,claimed_seconds,accepted_seconds,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [ctx.businessId, ctx.sub, v.sessionId, v.sequence, studentId, v.activeSeconds, acceptedSeconds, stale ? old!.last_received_at : now]);
            if (!stale) {
                await tx.query('INSERT INTO activity_sessions(business_id,actor_id,session_id,student_id,last_sequence,last_received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(business_id,actor_id,session_id) DO UPDATE SET student_id=EXCLUDED.student_id,last_sequence=EXCLUDED.last_sequence,last_received_at=EXCLUDED.last_received_at', [ctx.businessId, ctx.sub, v.sessionId, studentId, v.sequence, now]);
                if (!actor || actorGap >= 5)
                    await tx.query('INSERT INTO activity_actor_cursors(business_id,actor_id,last_received_at) VALUES($1,$2,$3) ON CONFLICT(business_id,actor_id) DO UPDATE SET last_received_at=EXCLUDED.last_received_at', [ctx.businessId, ctx.sub, now]);
                await tx.query(`INSERT INTO activity_daily(business_id,actor_id,student_id,day,active_seconds,last_seen_at) VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE 'UTC')::date,$5,$4) ON CONFLICT(business_id,actor_id,student_id,day) DO UPDATE SET active_seconds=activity_daily.active_seconds+EXCLUDED.active_seconds,last_seen_at=greatest(activity_daily.last_seen_at,EXCLUDED.last_seen_at)`, [ctx.businessId, ctx.sub, studentId, now, acceptedSeconds]);
                if (acceptedSeconds)
                    await emitEvent(tx, {
                        type: 'reporting.activity-recorded.v1', producer: 'reporting', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                            studentId, acceptedSeconds, estimated: true, scope: 'tuts'
                        }
                    });
            }
            return {
                item: {
                    acceptedSeconds, duplicate: false, lastSeenAt: (stale ? old!.last_received_at : now).toISOString()
                }
            };
        });
    }
    async activityHistory(ctx: RequestContext, id: string, period: Period, limit: number, offset: number) {
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockReports(tx, ctx.businessId);
            const studentId = await authorizedRoot(tx, ctx, id), values = [studentId, period.timeZone, period.month];
            const where = `student_id=$1 AND (received_at AT TIME ZONE $2)::date>=($3||'-01')::date AND (received_at AT TIME ZONE $2)::date<(($3||'-01')::date+interval '1 month')`;
            const count = await tx.query<{
                total: string;
            }>(`SELECT count(DISTINCT (received_at AT TIME ZONE $2)::date) total FROM activity_receipts WHERE ${where}`, values);
            const rows = await tx.query<{
                day: string;
                active_seconds: string;
                last_seen: Date;
            }>(`SELECT to_char((received_at AT TIME ZONE $2)::date,'YYYY-MM-DD') day,sum(accepted_seconds)::text active_seconds,max(received_at) last_seen FROM activity_receipts WHERE ${where} GROUP BY (received_at AT TIME ZONE $2)::date ORDER BY (received_at AT TIME ZONE $2)::date DESC LIMIT $4 OFFSET $5`, [...values, limit, offset]);
            return {
                items: rows.rows.map(r => ({
                    date: r.day, activeSeconds: safeCount(r.active_seconds), lastSeenAt: r.last_seen.toISOString()
                })), total: safeCount(count.rows[0]!.total), limit, offset, studentId, ...period, estimated: true, scope: 'tuts', asOf: new Date().toISOString()
            };
        });
    }
}
