import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CurrentContext, Database, Permissions, Roles, StudentScoped, parseBody, assertStudentAccess, emitEvent } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { lockContacts, item, type ClientRow } from './contact-store.js';
import { requireStudent } from './student-identity.js';
import { groupItem, groupSelect, requireGroup, emitGroupMembers, type GroupRow } from './groups-store.js';
const page = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0)
}).strict();
const create = z.object({
    name: z.string().trim().min(1).max(160), description: z.string().max(2000).nullable().optional()
}).strict();
const patch = create.partial().refine(v => Object.keys(v).length > 0, 'Provide at least one field');
const members = z.object({
    studentIds: z.array(z.uuid()).min(1).max(500)
}).strict();
@Roles('owner', 'admin', 'tutor')
@Controller('v1/groups')
export class GroupsController {
    constructor(
    @Inject(Database)
    private readonly db: Database) {
    }
    @Get()
    @StudentScoped()
    @Permissions('clients.read')
    async list(
    @CurrentContext()
    ctx: RequestContext, 
    @Query()
    query: unknown) {
        const { limit, offset } = parseBody(page, query);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const scoped = ctx.accessScope === 'students', values: unknown[] = scoped ? [ctx.studentIds ?? []] : [];
            const condition = scoped ? 'WHERE EXISTS(SELECT 1 FROM student_group_members m WHERE m.group_id=g.id AND m.student_id=ANY($1::uuid[]))' : '';
            const count = await tx.query<{
                total: string;
            }>(`SELECT count(*) total FROM student_groups g ${condition}`, values);
            const select = scoped ? `SELECT g.*,(SELECT count(*) FROM student_group_members m WHERE m.group_id=g.id AND m.student_id=ANY($1::uuid[]))::text student_count FROM student_groups g` : groupSelect;
            const rows = await tx.query<GroupRow>(`${select} ${condition} ORDER BY g.created_at DESC,g.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
            return {
                items: rows.rows.map(groupItem), total: Number(count.rows[0]!.total), limit, offset
            };
        });
    }
    @Post()
    @Permissions('clients.groups.manage')
    async create(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        const input = parseBody(create, body);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            const id = randomUUID();
            await tx.query('INSERT INTO student_groups(business_id,id,name,description) VALUES($1,$2,$3,$4)', [ctx.businessId, id, input.name, input.description ?? null]);
            await emitEvent(tx, {
                type: 'clients.group-created.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                    groupId: id, revision: 1
                }
            });
            return {
                item: groupItem(await requireGroup(tx, id))
            };
        });
    }
    @Get(':id')
    @StudentScoped()
    @Permissions('clients.read')
    async get(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string) {
        const id = parseBody(z.uuid(), value);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const row = await requireGroup(tx, id);
            if (ctx.accessScope === 'students') {
                const count = await tx.query<{
                    count: string;
                }>('SELECT count(*) FROM student_group_members WHERE group_id=$1 AND student_id=ANY($2::uuid[])', [id, ctx.studentIds ?? []]);
                if (!Number(count.rows[0]!.count))
                    throw new ConflictException('No granted student belongs to this group');
                row.student_count = count.rows[0]!.count;
            }
            return {
                item: groupItem(row)
            };
        });
    }
    @Patch(':id')
    @Permissions('clients.groups.manage')
    async update(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Body()
    body: unknown) {
        const id = parseBody(z.uuid(), value), input = parseBody(patch, body);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            const current = await requireGroup(tx, id);
            await tx.query('UPDATE student_groups SET name=$2,description=$3,revision=revision+1,updated_at=now() WHERE id=$1', [id, input.name ?? current.name, input.description === undefined ? current.description : input.description]);
            const row = await requireGroup(tx, id);
            await emitEvent(tx, {
                type: 'clients.group-updated.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                    groupId: id, revision: row.revision
                }
            });
            return {
                item: groupItem(row)
            };
        });
    }
    @Delete(':id')
    @Permissions('clients.groups.manage')
    async remove(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string) {
        const id = parseBody(z.uuid(), value);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            const row = await requireGroup(tx, id);
            await tx.query('UPDATE clients SET revision=revision+1,updated_at=now() WHERE id IN (SELECT student_id FROM student_group_members WHERE group_id=$1)', [id]);
            await tx.query('DELETE FROM student_groups WHERE id=$1', [id]);
            await emitEvent(tx, {
                type: 'clients.group-deleted.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                    groupId: id, revision: row.revision + 1
                }
            });
            return {
                item: {
                    id, deleted: true
                }
            };
        });
    }
    @Get(':id/members')
    @StudentScoped()
    @Permissions('clients.read')
    async members(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Query()
    query: unknown) {
        const id = parseBody(z.uuid(), value), { limit, offset } = parseBody(page, query);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await requireGroup(tx, id);
            const scoped = ctx.accessScope === 'students', values: unknown[] = scoped ? [id, ctx.studentIds ?? []] : [id];
            const condition = `m.group_id=$1 AND c.merged_into IS NULL${scoped ? ' AND c.id=ANY($2::uuid[])' : ''}`;
            const from = 'FROM student_group_members m JOIN clients c ON c.business_id=m.business_id AND c.id=m.student_id';
            const count = await tx.query<{
                total: string;
            }>(`SELECT count(*) total ${from} WHERE ${condition}`, values);
            const rows = await tx.query<ClientRow>(`SELECT c.* ${from} WHERE ${condition} ORDER BY c.display_name,c.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
            return {
                items: rows.rows.map(item), total: Number(count.rows[0]!.total), limit, offset
            };
        });
    }
    @Post(':id/members')
    @Permissions('clients.groups.manage')
    async add(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Body()
    body: unknown) {
        return this.mutate(ctx, parseBody(z.uuid(), value), parseBody(members, body).studentIds, 'added');
    }
    @Delete(':id/members')
    @Permissions('clients.groups.manage')
    async removeMembers(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Body()
    body: unknown) {
        return this.mutate(ctx, parseBody(z.uuid(), value), parseBody(members, body).studentIds, 'removed');
    }
    private async mutate(ctx: RequestContext, id: string, ids: string[], action: 'added' | 'removed') {
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockContacts(tx, ctx.businessId);
            await requireGroup(tx, id);
            const canonical = new Set<string>();
            for (const id of ids) {
                const student = await requireStudent(tx, id);
                assertStudentAccess(ctx, student.id);
                canonical.add(student.id);
            }
            const changed = action === 'added' ? await tx.query<{
                student_id: string;
            }>(`INSERT INTO student_group_members(business_id,group_id,student_id) SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING RETURNING student_id`, [ctx.businessId, id, [...canonical]]) : await tx.query<{
                student_id: string;
            }>('DELETE FROM student_group_members WHERE group_id=$1 AND student_id=ANY($2::uuid[]) RETURNING student_id', [id, [...canonical]]);
            const studentIds = changed.rows.map(r => r.student_id).sort();
            if (studentIds.length)
                await tx.query('UPDATE clients SET revision=revision+1,updated_at=now() WHERE id=ANY($1::uuid[])', [studentIds]);
            await emitGroupMembers(tx, ctx, id, studentIds, action);
            return {
                item: groupItem(await requireGroup(tx, id)), studentIds
            };
        });
    }
}
