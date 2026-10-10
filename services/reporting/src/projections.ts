import { ConflictException, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventBus } from '@palladium/service-kit';
import type { PlatformEvent } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { z } from 'zod';
const revision = z.number().int().positive();
const student = z.uuid().nullable().optional();
const classSchema = z.object({
    classId: z.uuid(), source: z.enum(['internal', 'external']), clientId: student, studentId: student, startsAt: z.string().datetime(), endsAt: z.string().datetime(), status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']), attendanceSource: z.string().max(40).nullable().optional(), revision
});
const assignmentSchema = z.object({
    assignmentId: z.uuid(), clientId: student, studentId: student, status: z.enum(['assigned', 'submitted', 'completed', 'needs_revision']).default('assigned'), dueAt: z.string().datetime().nullable().optional(), createdAt: z.string().datetime().nullable().optional(), revision: revision.default(1)
});
const resourceSchema = z.object({
    resourceId: z.uuid(), clientId: student, studentId: student, assignmentId: z.uuid().nullable().optional(), kind: z.string().max(40), revision
});
const invoiceSchema = z.object({
    invoiceId: z.uuid(), clientId: student, studentId: student, status: z.string().max(30), amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), paidMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[A-Z]{3}$/), issuedAt: z.string().datetime().nullable().optional(), serviceMonth: z.string().nullable().optional(), eventAt: z.string().datetime().optional(), revision
});
// Shared locks allow summaries to overlap while excluding alias/projection writes
// for the full tenant transaction, preserving one canonical identity throughout.
export async function lockReports(tx: PoolClient, businessId: string, mode: 'read' | 'write' = 'write') {
    const lock = mode === 'read' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    await tx.query(`SELECT ${lock}(hashtextextended($1,0))`, [`reporting:${businessId}`]);
}
export async function studentRoot(tx: PoolClient, id: string): Promise<string> {
    const seen = new Set<string>();
    let current = id;
    for (let i = 0; i < 50; i++) {
        if (seen.has(current))
            throw new ConflictException('Student identity requires reconciliation');
        seen.add(current);
        const row = await tx.query<{
            target_id: string;
        }>('SELECT target_id FROM report_student_aliases WHERE source_id=$1', [current]);
        if (!row.rows[0])
            return current;
        current = row.rows[0].target_id;
    }
    throw new ConflictException('Student alias chain exceeds limit');
}
export async function projectClass(tx: PoolClient, businessId: string, raw: unknown) {
    const v = classSchema.parse(raw), id = v.studentId ?? v.clientId, target = id ? await studentRoot(tx, id) : null;
    await tx.query(`INSERT INTO report_classes(business_id,source,class_id,student_id,starts_at,ends_at,status,attendance_source,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(business_id,source,class_id) DO UPDATE SET student_id=EXCLUDED.student_id,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,status=EXCLUDED.status,attendance_source=EXCLUDED.attendance_source,revision=EXCLUDED.revision,observed_at=now() WHERE report_classes.revision<EXCLUDED.revision`, [businessId, v.source, v.classId, target, v.startsAt, v.endsAt, v.status, v.attendanceSource ?? null, v.revision]);
}
export async function projectAssignment(tx: PoolClient, businessId: string, raw: unknown) {
    const v = assignmentSchema.parse(raw), id = v.studentId ?? v.clientId;
    if (!id)
        return;
    const target = await studentRoot(tx, id);
    await tx.query(`INSERT INTO report_assignments(business_id,assignment_id,student_id,status,due_at,created_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(business_id,assignment_id) DO UPDATE SET student_id=EXCLUDED.student_id,status=EXCLUDED.status,due_at=EXCLUDED.due_at,created_at=COALESCE(EXCLUDED.created_at,report_assignments.created_at),revision=EXCLUDED.revision,observed_at=now() WHERE report_assignments.revision<EXCLUDED.revision OR (report_assignments.revision=EXCLUDED.revision AND report_assignments.created_at IS NULL AND EXCLUDED.created_at IS NOT NULL)`, [businessId, v.assignmentId, target, v.status, v.dueAt ?? null, v.createdAt ?? null, v.revision]);
    if (v.createdAt)
        await tx.query('UPDATE report_assignments SET created_at=$2 WHERE assignment_id=$1 AND created_at IS NULL', [v.assignmentId, v.createdAt]);
}
export async function projectResource(tx: PoolClient, businessId: string, raw: unknown) {
    const v = resourceSchema.parse(raw), id = v.studentId ?? v.clientId;
    if (!id)
        return;
    const target = await studentRoot(tx, id);
    await tx.query(`INSERT INTO report_resources(business_id,resource_id,student_id,assignment_id,kind,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(business_id,resource_id) DO UPDATE SET student_id=EXCLUDED.student_id,assignment_id=EXCLUDED.assignment_id,kind=EXCLUDED.kind,revision=EXCLUDED.revision,observed_at=now() WHERE report_resources.revision<EXCLUDED.revision`, [businessId, v.resourceId, target, v.assignmentId ?? null, v.kind, v.revision]);
}
export async function projectInvoice(tx: PoolClient, businessId: string, raw: unknown) {
    if (raw && typeof raw === 'object' && !('studentId' in raw && (raw as Record<string, unknown>).studentId) && !('clientId' in raw && (raw as Record<string, unknown>).clientId))
        return;
    const v = invoiceSchema.parse(raw), id = v.studentId ?? v.clientId;
    if (!id)
        return;
    const target = await studentRoot(tx, id);
    const changed = await tx.query(`INSERT INTO report_invoices(business_id,invoice_id,student_id,status,amount_minor,paid_minor,currency,issued_at,service_month,event_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(business_id,invoice_id) DO UPDATE SET student_id=EXCLUDED.student_id,status=EXCLUDED.status,amount_minor=EXCLUDED.amount_minor,paid_minor=EXCLUDED.paid_minor,currency=EXCLUDED.currency,issued_at=EXCLUDED.issued_at,service_month=EXCLUDED.service_month,event_at=EXCLUDED.event_at,revision=EXCLUDED.revision,observed_at=now() WHERE report_invoices.revision<EXCLUDED.revision RETURNING student_id`, [businessId, v.invoiceId, target, v.status, v.amountMinor, v.paidMinor, v.currency, v.issuedAt ?? null, v.serviceMonth ?? null, v.eventAt ?? null, v.revision]);
    if (changed.rowCount && v.eventAt)
        await tx.query("UPDATE report_finance_snapshots SET complete=false WHERE student_id=$1 AND as_of<$2::timestamptz", [target, v.eventAt]);
}
@Injectable()
export class ReportingProjection implements OnModuleInit {
    constructor(
    @Inject(EventBus)
    private readonly events: EventBus) {
    }
    onModuleInit() {
        this.events.subscribe('scheduling.class-updated.v1', (e, tx) => this.apply(e, tx, 'scheduling', projectClass));
        for (const type of ['learning.assignment-created.v1', 'learning.assignment-submitted.v1', 'learning.assignment-reviewed.v1', 'learning.assignment-updated.v1'])
            this.events.subscribe(type, (e, tx) => this.apply(e, tx, 'learning', projectAssignment));
        for (const type of ['learning.resource-created.v1', 'learning.resource-updated.v1'])
            this.events.subscribe(type, (e, tx) => this.apply(e, tx, 'learning', projectResource));
        this.events.subscribe('billing.invoice-updated.v1', (e, tx) => this.apply(e, tx, 'billing', projectInvoice));
        this.events.subscribe('clients.student-merged.v1', (e, tx) => this.merge(e, tx));
    }
    private async apply(event: PlatformEvent, tx: PoolClient, producer: string, project: (tx: PoolClient, businessId: string, raw: unknown) => Promise<void>) {
        if (event.producer !== producer)
            throw new Error('Invalid reporting event producer');
        await lockReports(tx, event.businessId);
        await project(tx, event.businessId, event.type === 'learning.assignment-created.v1' ? {
            ...event.data, createdAt: event.data.createdAt ?? event.occurredAt
        } : event.type === 'billing.invoice-updated.v1' ? {
            ...event.data, eventAt: event.occurredAt
        } : event.data);
    }
    private async merge(event: PlatformEvent, tx: PoolClient) {
        if (event.producer !== 'clients')
            throw new Error('Invalid reporting identity producer');
        const v = z.object({
            sourceId: z.uuid(), targetId: z.uuid(), revision
        }).parse(event.data);
        if (v.sourceId === v.targetId)
            throw new Error('Invalid reporting merge');
        await lockReports(tx, event.businessId);
        const target = await studentRoot(tx, v.targetId);
        if (target === v.sourceId)
            throw new Error('Cyclic reporting merge');
        const old = await tx.query<{
            revision: number;
        }>('SELECT revision FROM report_student_aliases WHERE source_id=$1', [v.sourceId]);
        if (old.rows[0] && old.rows[0].revision >= v.revision)
            return;
        const aliases = await tx.query<{
            source_id: string;
        }>('SELECT source_id FROM report_student_aliases WHERE target_id=$1', [v.sourceId]), sources = [v.sourceId, ...aliases.rows.map(r => r.source_id)];
        await tx.query('UPDATE report_student_aliases SET target_id=$2 WHERE target_id=$1', [v.sourceId, target]);
        await tx.query('INSERT INTO report_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT(business_id,source_id) DO UPDATE SET target_id=EXCLUDED.target_id,revision=EXCLUDED.revision', [event.businessId, v.sourceId, target, v.revision]);
        for (const table of ['report_classes', 'report_assignments', 'report_resources', 'report_invoices', 'activity_sessions', 'activity_receipts'])
            await tx.query(`UPDATE ${table} SET student_id=$2 WHERE student_id=ANY($1::uuid[])`, [sources, target]);
        await tx.query(`INSERT INTO activity_daily(business_id,actor_id,student_id,day,active_seconds,last_seen_at) SELECT business_id,actor_id,$2,day,sum(active_seconds),max(last_seen_at) FROM activity_daily WHERE student_id=ANY($1::uuid[]) GROUP BY business_id,actor_id,day ON CONFLICT(business_id,actor_id,student_id,day) DO UPDATE SET active_seconds=activity_daily.active_seconds+EXCLUDED.active_seconds,last_seen_at=greatest(activity_daily.last_seen_at,EXCLUDED.last_seen_at)`, [sources, target]);
        await tx.query('DELETE FROM activity_daily WHERE student_id=ANY($1::uuid[])', [sources]);
        await tx.query(`INSERT INTO attribution_link_students(business_id,link_id,student_id,linked_by,linked_at) SELECT business_id,link_id,$2,linked_by,linked_at FROM attribution_link_students WHERE student_id=ANY($1::uuid[]) ON CONFLICT(business_id,link_id,student_id) DO NOTHING`, [sources, target]);
        await tx.query('DELETE FROM attribution_link_students WHERE student_id=ANY($1::uuid[])', [sources]);
        // Separate complete histories are not proof of complete merged coverage.
        await tx.query('UPDATE report_coverage SET status=\'partial\',reason=\'Student merged; reconcile combined history\' WHERE student_id=ANY($1::uuid[])', [[...sources, target]]);
        await tx.query('UPDATE report_finance_snapshots SET complete=false WHERE student_id=ANY($1::uuid[])', [[...sources, target]]);
    }
}
