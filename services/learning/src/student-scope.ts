import { ConflictException, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { EventBus, assertStudentAccess, emitEvent } from '@palladium/service-kit';
import type { RequestContext, PlatformEvent } from '@palladium/contracts';
const merged = z.object({
    sourceId: z.uuid(), targetId: z.uuid(), revision: z.number().int().positive()
}).strict();
export async function lockLearning(tx: PoolClient, businessId: string) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`learning-students:${businessId}`]);
}
export function scopedIds(ctx: RequestContext): string[] | null {
    return ctx.accessScope === 'students' || ['student', 'parent'].includes(ctx.role) ? ctx.studentIds ?? [] : null;
}
export async function canonicalStudent(tx: PoolClient, id: string): Promise<string> {
    let current = id;
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
        if (seen.has(current))
            throw new ConflictException('Student identity needs reconciliation');
        seen.add(current);
        const row = await tx.query<{
            target_id: string;
        }>('SELECT target_id FROM learning_student_aliases WHERE source_id=$1', [current]);
        if (!row.rows[0])
            return current;
        current = row.rows[0].target_id;
    }
    throw new ConflictException('Student identity chain exceeds reconciliation limit');
}
export async function authorizedStudent(tx: PoolClient, ctx: RequestContext, id: string) {
    assertStudentAccess(ctx, id);
    const canonical = await canonicalStudent(tx, id);
    assertStudentAccess(ctx, canonical);
    return canonical;
}
@Injectable()
export class LearningIdentity implements OnModuleInit {
    constructor(
    @Inject(EventBus)
    private readonly events: EventBus) {
    }
    onModuleInit() {
        this.events.subscribe('clients.student-merged.v1', (event, tx) => this.merge(event, tx));
    }
    async merge(event: PlatformEvent, tx: PoolClient) {
        if (event.producer !== 'clients')
            throw new Error('Invalid student identity producer');
        const input = merged.parse(event.data);
        if (input.sourceId === input.targetId)
            throw new Error('Invalid student identity merge');
        await lockLearning(tx, event.businessId);
        const target = await canonicalStudent(tx, input.targetId);
        if (target === input.sourceId)
            throw new Error('Cyclic student identity merge');
        const old = await tx.query<{
            revision: number;
        }>('SELECT revision FROM learning_student_aliases WHERE source_id=$1', [input.sourceId]);
        if (old.rows[0] && old.rows[0].revision >= input.revision)
            return;
        const sources = await tx.query<{
            source_id: string;
        }>('SELECT source_id FROM learning_student_aliases WHERE target_id=$1', [input.sourceId]);
        const sourceIds = [input.sourceId, ...sources.rows.map(r => r.source_id)];
        await tx.query('UPDATE learning_student_aliases SET target_id=$2 WHERE target_id=$1', [input.sourceId, target]);
        await tx.query('INSERT INTO learning_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT(business_id,source_id) DO UPDATE SET target_id=EXCLUDED.target_id,revision=EXCLUDED.revision', [event.businessId, input.sourceId, target, input.revision]);
        const assignments = await tx.query<{
            id: string;
            client_id: string;
            status: string;
            due_at: Date | null;
            revision: number;
        }>('UPDATE assignments SET client_id=$2,revision=revision+1,updated_at=now() WHERE client_id=ANY($1::uuid[]) RETURNING id,client_id,status,due_at,revision', [sourceIds, target]);
        const resources = await tx.query<{
            id: string;
            client_id: string;
            kind: string;
            revision: number;
            submission_assignment_id: string | null;
        }>('UPDATE resources SET client_id=$2,revision=revision+1 WHERE client_id=ANY($1::uuid[]) RETURNING id,client_id,kind,revision,submission_assignment_id', [sourceIds, target]);
        for (const a of assignments.rows)
            await emitEvent(tx, {
                type: 'learning.assignment-updated.v1', producer: 'learning', businessId: event.businessId, correlationId: event.correlationId, data: {
                    assignmentId: a.id, studentId: target, clientId: target, status: a.status, dueAt: a.due_at?.toISOString() ?? null, revision: a.revision
                }
            });
        for (const r of resources.rows)
            await emitEvent(tx, {
                type: 'learning.resource-updated.v1', producer: 'learning', businessId: event.businessId, correlationId: event.correlationId, data: {
                    resourceId: r.id, studentId: target, clientId: target, kind: r.kind, revision: r.revision, assignmentId: r.submission_assignment_id
                }
            });
    }
}
