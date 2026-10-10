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
type StoredCoverage = { student_id: string; source: string; status: Coverage['status']; as_of: Date | null; reason: string | null };
type FinanceSnapshot = { student_id: string; totals: unknown[]; invoice_count: number; as_of: Date; complete: boolean };
type SummaryAggregate = {
    student_id: string; scheduling: Date | null; learning: Date | null; resources: Date | null; undated: boolean | null;
    booked: string | null; class_completed: string | null; cancelled: string | null; no_show: string | null;
    assigned: string | null; submitted: string | null; homework_completed: string | null; needs_revision: string | null;
    materials: string | null; submission_files: string | null; active_seconds: string | null; last_seen: Date | null;
};
@Injectable()
export class ReportingService {
    constructor(
    @Inject(Database)
    private readonly db: Database) {
    }
    async summaries(ctx: RequestContext, ids: string[], period: Period, financial = false) {
        if (financial) assertFinancial(ctx);
        const requested = [...new Set(ids)];
        for (const id of requested) assertStudentAccess(ctx, id);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockReports(tx, ctx.businessId);
            if (!requested.length) return { items: [], asOf: null };
            const aliases = await tx.query<{ requested_id: string; student_id: string; depth: number; cycle: boolean }>(`
                WITH RECURSIVE roots AS (
                    SELECT id requested_id,id student_id,0 depth,ARRAY[id] path,false cycle FROM unnest($1::uuid[]) id
                    UNION ALL
                    SELECT r.requested_id,a.target_id,r.depth+1,r.path||a.target_id,a.target_id=ANY(r.path)
                    FROM roots r JOIN report_student_aliases a ON a.source_id=r.student_id
                    WHERE r.depth<50 AND NOT r.cycle
                ) SELECT DISTINCT ON (requested_id) requested_id,student_id,depth,cycle FROM roots ORDER BY requested_id,depth DESC`, [requested]);
            const roots = new Map(aliases.rows.map(row => {
                if (row.depth >= 50) throw new ConflictException('Student alias chain exceeds limit');
                if (row.cycle) throw new ConflictException('Student identity requires reconciliation');
                assertStudentAccess(ctx, row.student_id);
                return [row.requested_id, row.student_id];
            }));
            const canonical = [...new Set(requested.map(id => roots.get(id)!))];
            const aggregates = await tx.query<SummaryAggregate>(`
                WITH period AS (SELECT ($3||'-01')::date first_day,(($3||'-01')::date+interval '1 month') last_day),
                classes AS (
                    SELECT student_id,max(observed_at) scheduling,
                        count(*) FILTER(WHERE status='scheduled' AND (starts_at AT TIME ZONE $2)::date>=p.first_day AND (starts_at AT TIME ZONE $2)::date<p.last_day) booked,
                        count(*) FILTER(WHERE status='completed' AND (starts_at AT TIME ZONE $2)::date>=p.first_day AND (starts_at AT TIME ZONE $2)::date<p.last_day) class_completed,
                        count(*) FILTER(WHERE status='cancelled' AND (starts_at AT TIME ZONE $2)::date>=p.first_day AND (starts_at AT TIME ZONE $2)::date<p.last_day) cancelled,
                        count(*) FILTER(WHERE status='no_show' AND (starts_at AT TIME ZONE $2)::date>=p.first_day AND (starts_at AT TIME ZONE $2)::date<p.last_day) no_show
                    FROM report_classes CROSS JOIN period p WHERE student_id=ANY($1::uuid[]) GROUP BY student_id
                ), homework AS (
                    SELECT student_id,max(observed_at) learning,bool_or(due_at IS NULL AND created_at IS NULL) undated,
                        count(*) FILTER(WHERE status='assigned' AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date>=p.first_day AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date<p.last_day) assigned,
                        count(*) FILTER(WHERE status='submitted' AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date>=p.first_day AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date<p.last_day) submitted,
                        count(*) FILTER(WHERE status='completed' AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date>=p.first_day AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date<p.last_day) homework_completed,
                        count(*) FILTER(WHERE status='needs_revision' AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date>=p.first_day AND (coalesce(due_at,created_at) AT TIME ZONE $2)::date<p.last_day) needs_revision
                    FROM report_assignments CROSS JOIN period p WHERE student_id=ANY($1::uuid[]) GROUP BY student_id
                ), resources AS (
                    SELECT student_id,max(observed_at) resources,count(*) FILTER(WHERE assignment_id IS NULL) materials,count(*) FILTER(WHERE assignment_id IS NOT NULL) submission_files
                    FROM report_resources WHERE student_id=ANY($1::uuid[]) GROUP BY student_id
                ), activity AS (
                    SELECT student_id,coalesce(sum(accepted_seconds) FILTER(WHERE (received_at AT TIME ZONE $2)::date>=p.first_day AND (received_at AT TIME ZONE $2)::date<p.last_day),0)::text active_seconds,max(received_at) last_seen
                    FROM activity_receipts CROSS JOIN period p WHERE student_id=ANY($1::uuid[]) GROUP BY student_id
                ) SELECT ids.student_id,classes.scheduling,classes.booked,classes.class_completed,classes.cancelled,classes.no_show,
                    homework.learning,homework.undated,homework.assigned,homework.submitted,homework.homework_completed,homework.needs_revision,
                    resources.resources,resources.materials,resources.submission_files,activity.active_seconds,activity.last_seen
                FROM unnest($1::uuid[]) ids(student_id) LEFT JOIN classes USING(student_id) LEFT JOIN homework USING(student_id) LEFT JOIN resources USING(student_id) LEFT JOIN activity USING(student_id)`, [canonical, period.timeZone, period.month]);
            const stored = await tx.query<StoredCoverage>(`SELECT student_id,source,status,as_of,reason FROM report_coverage WHERE student_id=ANY($1::uuid[]) AND month=$2 AND time_zone=$3 AND source=ANY($4::text[])`, [canonical, period.month, period.timeZone, financial ? ['scheduling','learning','billing'] : ['scheduling','learning']]);
            const coverage = new Map<string, StoredCoverage[]>();
            for (const row of stored.rows) coverage.set(row.student_id, [...coverage.get(row.student_id) ?? [], row]);
            const snapshots = financial ? (await tx.query<FinanceSnapshot>('SELECT student_id,totals,invoice_count,as_of,complete FROM report_finance_snapshots WHERE student_id=ANY($1::uuid[])', [canonical])).rows : [];
            const snapshotById = new Map(snapshots.map(row => [row.student_id,row]));
            const aggregateById = new Map(aggregates.rows.map(row => [row.student_id,row]));
            const items = requested.map(id => {
                const studentId = roots.get(id)!;
                return this.summary(studentId,period,financial,aggregateById.get(studentId)!,coverage.get(studentId) ?? [],snapshotById.get(studentId));
            });
            return { items, asOf: items.reduce<string | null>((a,b) => b.asOf && (!a || b.asOf>a) ? b.asOf : a,null) };
        });
    }
    private summary(studentId: string, period: Period, financial: boolean, aggregate: SummaryAggregate, stored: StoredCoverage[], snapshot?: FinanceSnapshot) {
        const {month,timeZone} = period;
        const sourceCoverage = (source: string, seen: Date | null): Coverage => {
            const row = stored.find(r => r.source === source);
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
            scheduling: sourceCoverage('scheduling', aggregate.scheduling), learning: sourceCoverage('learning', aggregate.learning ?? aggregate.resources)
        };
        if (aggregate.undated && coverage.learning.status === 'complete')
            coverage.learning = { ...coverage.learning, status: 'partial', reason: 'Some homework dates are unknown; reconcile source history' };
        const observedCounts = (source: Coverage, value: unknown) => source.status === 'missing' || (source.status === 'unavailable' && !source.asOf) ? null : safeCount(value);
        let finance: undefined | {
            period: 'all_time';
            totalsByCurrency: unknown[] | null;
            issuedInvoiceCount: number | null;
            asOf: string | null;
        };
        if (financial) {
            coverage.billing = snapshot?.complete ? {
                status: 'complete', asOf: snapshot.as_of.toISOString()
            } : sourceCoverage('billing', snapshot?.as_of ?? null);
            finance = {
                period: 'all_time', totalsByCurrency: snapshot?.complete ? snapshot.totals : null, issuedInvoiceCount: snapshot?.complete ? snapshot.invoice_count : null, asOf: snapshot?.as_of.toISOString() ?? null
            };
        }
        const asOf = [coverage.scheduling.asOf, coverage.learning.asOf, coverage.billing?.asOf, aggregate.last_seen?.toISOString()].filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
        return {
            studentId, month, timeZone, bookings: {
                booked: observedCounts(coverage.scheduling, aggregate.booked), completed: observedCounts(coverage.scheduling, aggregate.class_completed), cancelled: observedCounts(coverage.scheduling, aggregate.cancelled), noShow: observedCounts(coverage.scheduling, aggregate.no_show)
            }, homework: {
                assigned: observedCounts(coverage.learning, aggregate.assigned), submitted: observedCounts(coverage.learning, aggregate.submitted), completed: observedCounts(coverage.learning, aggregate.homework_completed), needsRevision: observedCounts(coverage.learning, aggregate.needs_revision)
            }, resources: {
                period: 'all_time' as const, materials: observedCounts(coverage.learning, aggregate.materials), submissionFiles: observedCounts(coverage.learning, aggregate.submission_files)
            }, activity: {
                activeSeconds: safeCount(aggregate.active_seconds), lastSeenAt: aggregate.last_seen?.toISOString() ?? null, estimated: true as const, scope: 'tuts' as const
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
