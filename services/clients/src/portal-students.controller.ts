import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentContext, Database, Permissions, StudentScoped, assertStudentAccess, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { type ClientRow } from './contact-store.js';
import { requireStudent } from './student-identity.js';
const pagination = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0)
}).strict();
@StudentScoped()
@Permissions('clients.read')
@Controller('v1/portal/students')
export class PortalStudentsController {
    constructor(
    @Inject(Database)
    private readonly db: Database) {
    }
    @Get()
    async list(
    @CurrentContext()
    ctx: RequestContext, 
    @Query()
    query: unknown) {
        const { limit, offset } = parseBody(pagination, query);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const scoped = ctx.accessScope === 'students' || ['student', 'parent'].includes(ctx.role), values: unknown[] = scoped ? [ctx.studentIds ?? []] : [];
            const condition = `kind='student' AND merged_into IS NULL${scoped ? ' AND id=ANY($1::uuid[])' : ''}`;
            const count = await tx.query<{
                total: string;
            }>(`SELECT count(*) total FROM clients WHERE ${condition}`, values);
            const rows = await tx.query<ClientRow>(`SELECT * FROM clients WHERE ${condition} ORDER BY display_name,id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
            const items = await Promise.all(rows.rows.map(row => this.safeItem(tx, ctx, row)));
            return {
                items, total: Number(count.rows[0]!.total), limit, offset
            };
        });
    }
    @Get(':id')
    async get(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string) {
        const id = parseBody(z.uuid(), value);
        assertStudentAccess(ctx, id);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const row = await requireStudent(tx, id);
            assertStudentAccess(ctx, row.id);
            return {
                item: await this.safeItem(tx, ctx, row)
            };
        });
    }
    private async safeItem(tx: PoolClient, ctx: RequestContext, row: ClientRow) {
        assertStudentAccess(ctx, row.id);
        // Portal contacts expose designated addresses, never the legacy CRM row.
        const contacts = await tx.query<{
            id: string;
            display_name: string;
            relationship: string;
            is_primary: boolean;
            emails: unknown;
            phones: unknown;
        }>(`SELECT c.id,c.display_name,s.relationship,s.is_primary,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'value',a.value,'label',a.label,'isPrimary',a.is_primary) ORDER BY a.is_primary DESC,a.id) FROM contact_addresses a WHERE a.business_id=c.business_id AND a.contact_id=c.id AND a.kind='email'),'[]'::jsonb) emails,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'value',a.value,'label',a.label,'isPrimary',a.is_primary) ORDER BY a.is_primary DESC,a.id) FROM contact_addresses a WHERE a.business_id=c.business_id AND a.contact_id=c.id AND a.kind='phone'),'[]'::jsonb) phones FROM student_contacts s JOIN related_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.student_id=$1 ORDER BY s.is_primary DESC,c.id LIMIT 100`, [row.id]);
        return {
            id: row.id, firstName: row.first_name, lastName: row.last_name, displayName: row.display_name, photo: row.photo ?? null, revision: row.revision, contacts: contacts.rows.map(c => ({
                id: c.id, displayName: c.display_name, relationship: c.relationship, isPrimary: c.is_primary, emails: c.emails, phones: c.phones
            }))
        };
    }
}
