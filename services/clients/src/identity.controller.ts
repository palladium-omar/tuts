import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, ConflictException } from '@nestjs/common';
import { CurrentContext, Database, Permissions, Roles, parseBody, emitEvent, assertStudentAccess, StudentScoped } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { clientIdSchema } from './schemas.js';
import { item, lockContacts, type ClientRow } from './contact-store.js';
import { commitMerge, listRelatedContacts, mergePreview, requireStudent, saveRelatedContact } from './student-identity.js';
const pair = z.object({
    sourceId: z.uuid(), targetId: z.uuid()
}).strict().refine(v => v.sourceId !== v.targetId, 'Choose two different students');
const address = (kind: 'email' | 'phone') => z.object({
    value: kind === 'email' ? z.email().max(320) : z.string().trim().min(3).max(40).refine(v => /[0-9]/.test(v), 'Phone requires digits'), label: z.string().trim().min(1).max(60).optional(), isPrimary: z.boolean().optional()
}).strict();
const contact = z.object({
    contactId: z.uuid().optional(), displayName: z.string().trim().min(1).max(160).optional(), relationship: z.enum(['student', 'parent', 'guardian', 'sponsor', 'self', 'other']).optional(), isPrimary: z.boolean().optional(), emails: z.array(address('email')).max(20).optional(), phones: z.array(address('phone')).max(20).optional()
}).strict().refine(v => (v.emails?.filter(a => a.isPrimary).length ?? 0) <= 1 && (v.phones?.filter(a => a.isPrimary).length ?? 0) <= 1, 'Only one primary address of each kind');
const merge = z.object({
    sourceId: z.uuid(), targetId: z.uuid(), sourceRevision: z.number().int().positive(), targetRevision: z.number().int().positive(), fieldChoices: z.record(z.string().max(100), z.enum(['source', 'target'])).default({})
}).strict();
const pagination = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0)
}).strict();
@StudentScoped()
@Roles('owner', 'admin', 'tutor')
@Controller('v1')
export class IdentityController {
    constructor(
    @Inject(Database)
    private readonly db: Database) {
    }
    private async authorizedContacts(tx: import("pg").PoolClient, ctx: RequestContext, id: string) {
        const student = await requireStudent(tx, id);
        assertStudentAccess(ctx, student.id);
        return listRelatedContacts(tx, student.id);
    }
    @Get('clients/:id/contacts')
    @Permissions('clients.read')
    async contacts(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string) {
        const id = parseBody(clientIdSchema, value);
        assertStudentAccess(ctx, id);
        return this.db.withTenant(ctx.businessId, async (tx) => ({
            items: await this.authorizedContacts(tx, ctx, id)
        }));
    }
    @Post('clients/:id/contacts')
    @Permissions('clients.write')
    async add(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Body()
    body: unknown) {
        const id = parseBody(clientIdSchema, value), input = parseBody(contact, body);
        assertStudentAccess(ctx, id);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            return {
                item: await saveRelatedContact(tx, ctx, id, input)
            };
        });
    }
    @Patch('clients/:id/contacts/:contactId')
    @Permissions('clients.write')
    async edit(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Param('contactId')
    contactValue: string, 
    @Body()
    body: unknown) {
        const id = parseBody(clientIdSchema, value), contactId = parseBody(clientIdSchema, contactValue), input = parseBody(contact, body);
        assertStudentAccess(ctx, id);
        if (input.contactId)
            throw new ConflictException('Contact identity cannot be changed');
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            return {
                item: await saveRelatedContact(tx, ctx, id, input, contactId)
            };
        });
    }
    @Delete('clients/:id/contacts/:contactId')
    @Permissions('clients.write')
    async detach(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Param('contactId')
    contactValue: string) {
        const id = parseBody(clientIdSchema, value), contactId = parseBody(clientIdSchema, contactValue);
        assertStudentAccess(ctx, id);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            const student = await requireStudent(tx, id);
            assertStudentAccess(ctx, student.id);
            await tx.query('DELETE FROM student_contacts WHERE student_id=$1 AND contact_id=$2', [student.id, contactId]);
            const revision = await tx.query<{
                revision: number;
            }>('UPDATE clients SET revision=revision+1 WHERE id=$1 RETURNING revision', [student.id]);
            await emitEvent(tx, {
                type: 'clients.contacts-updated.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                    clientId: student.id, revision: revision.rows[0]!.revision
                }
            });
            return {
                item: {
                    studentId: student.id, contactId, detached: true
                }
            };
        });
    }
    @Get('duplicates')
    @Permissions('clients.read')
    async duplicates(
    @CurrentContext()
    ctx: RequestContext, 
    @Query()
    query: unknown) {
        const { limit, offset } = parseBody(pagination, query);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            // Candidate reasons do not assert that two students are the same person.
            const where = `a.kind='student' AND b.kind='student' AND a.merged_into IS NULL AND b.merged_into IS NULL AND (a.normalized_name=b.normalized_name AND a.normalized_name<>'' OR EXISTS(SELECT 1 FROM student_contacts sa JOIN contact_addresses ea ON ea.business_id=sa.business_id AND ea.contact_id=sa.contact_id JOIN contact_addresses eb ON eb.business_id=ea.business_id AND eb.kind=ea.kind AND eb.normalized_value=ea.normalized_value JOIN student_contacts sb ON sb.business_id=eb.business_id AND sb.contact_id=eb.contact_id WHERE sa.student_id=a.id AND sb.student_id=b.id AND ea.kind='email')) AND NOT EXISTS(SELECT 1 FROM duplicate_dismissals d WHERE d.source_id=a.id AND d.target_id=b.id)`;
            const scope = ctx.accessScope === 'students' ? ctx.studentIds ?? [] : null;
            const scopeWhere = scope ? ' AND a.id=ANY($1::uuid[]) AND b.id=ANY($1::uuid[])' : '';
            const values: unknown[] = scope ? [scope] : [];
            const total = await tx.query<{
                total: string;
            }>(`SELECT count(*) total FROM clients a JOIN clients b ON b.business_id=a.business_id AND a.id<b.id WHERE ${where}${scopeWhere}`, values);
            const pairs = await tx.query<{
                source: ClientRow;
                target: ClientRow;
                name_match: boolean;
            }>(`SELECT row_to_json(a) source,row_to_json(b) target,a.normalized_name=b.normalized_name name_match FROM clients a JOIN clients b ON b.business_id=a.business_id AND a.id<b.id WHERE ${where}${scopeWhere} ORDER BY a.updated_at DESC,a.id,b.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
            return {
                items: pairs.rows.map(p => ({
                    source: item(p.source), target: item(p.target), reasons: p.name_match ? ['same normalized name'] : ['shared email (may be family)']
                })), total: Number(total.rows[0]!.total), limit, offset
            };
        });
    }
    @Post('duplicates/dismiss')
    @Permissions('clients.write')
    async dismiss(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        const input = parseBody(pair, body);
        assertStudentAccess(ctx, input.sourceId);
        assertStudentAccess(ctx, input.targetId);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            await requireStudent(tx, input.sourceId);
            await requireStudent(tx, input.targetId);
            const [a, b] = [input.sourceId, input.targetId].sort();
            await tx.query('INSERT INTO duplicate_dismissals(business_id,source_id,target_id,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ctx.businessId, a, b, ctx.sub]);
            return {
                item: {
                    ...input, dismissed: true
                }
            };
        });
    }
    @Post('merges/preview')
    @Permissions('clients.merge')
    async preview(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        const input = parseBody(pair, body);
        assertStudentAccess(ctx, input.sourceId);
        assertStudentAccess(ctx, input.targetId);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            return {
                item: await mergePreview(tx, input.sourceId, input.targetId)
            };
        });
    }
    @Post('merges')
    @Permissions('clients.merge')
    async commit(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        const input = parseBody(merge, body);
        assertStudentAccess(ctx, input.sourceId);
        assertStudentAccess(ctx, input.targetId);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            return commitMerge(tx, ctx, input);
        });
    }
}
