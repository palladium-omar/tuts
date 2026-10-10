import { Inject, Injectable, ConflictException, NotFoundException, StreamableFile } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { Database, emitEvent, parseBody, assertStudentAccess } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { assignmentView, resourceView, type AssignmentRow, type ResourceRow } from './learning-model.js';
import { resourceStorage, type ResourceStorage } from './storage.js';
import { validateUpload, type UploadedResourceFile } from './uploads.js';
import { assignmentSchema, listSchema, resourceListSchema, resourceSchema, reviewSchema, submissionSchema, uploadSchema, submissionUploadSchema, uuid } from './schemas.js';
import { authorizedStudent, lockLearning, scopedIds } from './student-scope.js';
const withResources = `SELECT a.*,ARRAY(SELECT ar.resource_id FROM assignment_resources ar WHERE ar.business_id=a.business_id AND ar.assignment_id=a.id ORDER BY ar.resource_id) resource_ids,ARRAY(SELECT ar.resource_id FROM assignment_submission_resources ar WHERE ar.business_id=a.business_id AND ar.assignment_id=a.id ORDER BY ar.resource_id) submission_resource_ids FROM assignments a`;
@Injectable()
export class LearningService {
    constructor(
    @Inject(Database)
    private readonly db: Database) {
    }
    storageFactory: () => ResourceStorage = resourceStorage;
    private async assignment(tx: PoolClient, ctx: RequestContext, id: string, lock = false) {
        parseBody(uuid, id);
        const rows = await tx.query<AssignmentRow>(`${lock ? 'SELECT * FROM assignments' : withResources} ${lock ? 'WHERE business_id=$1 AND id=$2 FOR UPDATE' : 'WHERE a.business_id=$1 AND a.id=$2'}`, [ctx.businessId, id]);
        const row = rows.rows[0];
        if (!row)
            throw new NotFoundException('Assignment not found');
        assertStudentAccess(ctx, row.client_id);
        return row;
    }
    private async assignmentDetail(tx: PoolClient, ctx: RequestContext, row: AssignmentRow) {
        assertStudentAccess(ctx, row.client_id);
        const ids = [...row.resource_ids ?? [], ...row.submission_resource_ids ?? []];
        const resources = ids.length ? (await tx.query<ResourceRow>('SELECT * FROM resources WHERE id=ANY($1::uuid[])', [ids])).rows : [];
        for (const resource of resources) {
            assertStudentAccess(ctx, resource.client_id);
            if (resource.client_id !== row.client_id)
                throw new ConflictException('Assignment resource identity needs reconciliation');
        }
        const byId = new Map(resources.map(r => [r.id, resourceView(r)]));
        return {
            ...assignmentView(row), resources: (row.resource_ids ?? []).map(id => byId.get(id)).filter(Boolean), submissionResources: (row.submission_resource_ids ?? []).map(id => byId.get(id)).filter(Boolean)
        };
    }
    private async assignmentEvent(tx: PoolClient, ctx: RequestContext, row: AssignmentRow, type: string) {
        await emitEvent(tx, {
            type, producer: 'learning', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                assignmentId: row.id, studentId: row.client_id, clientId: row.client_id, status: row.status, dueAt: row.due_at?.toISOString() ?? null, revision: row.revision
            }
        });
    }
    private async resourceEvent(tx: PoolClient, ctx: RequestContext, row: ResourceRow) {
        await emitEvent(tx, {
            type: 'learning.resource-created.v1', producer: 'learning', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                resourceId: row.id, studentId: row.client_id, clientId: row.client_id, kind: row.kind, revision: row.revision, assignmentId: row.submission_assignment_id
            }
        });
    }
    async listAssignments(ctx: RequestContext, query: unknown) {
        const q = parseBody(listSchema, query);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const clientId = q.clientId ? await authorizedStudent(tx, ctx, q.clientId) : null, scope = scopedIds(ctx);
            const values = [ctx.businessId, clientId, q.status ?? null, scope];
            const where = `a.business_id=$1 AND ($2::uuid IS NULL OR a.client_id=$2) AND ($3::text IS NULL OR a.status=$3) AND ($4::uuid[] IS NULL OR a.client_id=ANY($4::uuid[]))`;
            const count = await tx.query<{
                total: string;
            }>(`SELECT count(*) total FROM assignments a WHERE ${where}`, values);
            const rows = await tx.query<AssignmentRow>(`${withResources} WHERE ${where} ORDER BY a.created_at DESC,a.id LIMIT $5 OFFSET $6`, [...values, q.limit, q.offset]);
            const items = await Promise.all(rows.rows.map(r => this.assignmentDetail(tx, ctx, r)));
            return {
                items, total: Number(count.rows[0]!.total), limit: q.limit, offset: q.offset
            };
        });
    }
    async getAssignment(ctx: RequestContext, id: string) {
        return this.db.withTenant(ctx.businessId, async (tx) => ({
            item: await this.assignmentDetail(tx, ctx, await this.assignment(tx, ctx, id))
        }));
    }
    async createAssignment(ctx: RequestContext, body: unknown) {
        const v = parseBody(assignmentSchema, body);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockLearning(tx, ctx.businessId);
            const clientId = await authorizedStudent(tx, ctx, v.clientId);
            if (v.resourceIds.length) {
                const rows = await tx.query<ResourceRow>("SELECT * FROM resources WHERE client_id=$1 AND id=ANY($2::uuid[]) AND purpose='material'", [clientId, v.resourceIds]);
                if (rows.rowCount !== v.resourceIds.length)
                    throw new NotFoundException('A resource is missing or does not belong to this student');
                for (const r of rows.rows)
                    assertStudentAccess(ctx, r.client_id);
            }
            const created = await tx.query<AssignmentRow>('INSERT INTO assignments(id,business_id,client_id,title,description,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [randomUUID(), ctx.businessId, clientId, v.title, v.description, v.dueAt ?? null, ctx.sub]);
            const row = created.rows[0]!;
            for (const resourceId of v.resourceIds)
                await tx.query('INSERT INTO assignment_resources(business_id,assignment_id,resource_id) VALUES($1,$2,$3)', [ctx.businessId, row.id, resourceId]);
            await this.assignmentEvent(tx, ctx, row, 'learning.assignment-created.v1');
            return {
                item: await this.assignmentDetail(tx, ctx, {
                    ...row, resource_ids: v.resourceIds, submission_resource_ids: []
                })
            };
        });
    }
    async submit(ctx: RequestContext, id: string, body: unknown) {
        const v = parseBody(submissionSchema, body);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockLearning(tx, ctx.businessId);
            const row = await this.assignment(tx, ctx, id, true);
            if (v.expectedRevision !== undefined && v.expectedRevision !== row.revision)
                throw new ConflictException('Assignment changed; refresh before submitting');
            if (!['assigned', 'needs_revision'].includes(row.status))
                throw new ConflictException('Assignment must be assigned or need revision before submission');
            const resourceIds = [...new Set(v.submissionResourceIds)];
            if (resourceIds.length) {
                const resources = await tx.query<ResourceRow>("SELECT * FROM resources WHERE id=ANY($1::uuid[]) AND client_id=$2 AND purpose='submission' AND submission_assignment_id=$3 AND storage_status='stored'", [resourceIds, row.client_id, id]);
                if (resources.rowCount !== resourceIds.length)
                    throw new NotFoundException('A submission file is missing or belongs to another assignment');
                for (const r of resources.rows)
                    assertStudentAccess(ctx, r.client_id);
            }
            await tx.query('DELETE FROM assignment_submission_resources WHERE assignment_id=$1', [id]);
            for (const resourceId of resourceIds)
                await tx.query('INSERT INTO assignment_submission_resources(business_id,assignment_id,resource_id) VALUES($1,$2,$3)', [ctx.businessId, id, resourceId]);
            await tx.query("UPDATE assignments SET status='submitted',submission_text=$3,submission_url=$4,submitted_at=now(),feedback=NULL,reviewed_at=NULL,reviewed_by=NULL,updated_at=now(),revision=revision+1 WHERE business_id=$1 AND id=$2", [ctx.businessId, id, v.submissionText ?? null, v.submissionUrl ?? null]);
            const updated = await this.assignment(tx, ctx, id);
            await this.assignmentEvent(tx, ctx, updated, 'learning.assignment-submitted.v1');
            return {
                item: await this.assignmentDetail(tx, ctx, updated)
            };
        });
    }
    async review(ctx: RequestContext, id: string, body: unknown) {
        const v = parseBody(reviewSchema, body);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockLearning(tx, ctx.businessId);
            const row = await this.assignment(tx, ctx, id, true);
            if (v.expectedRevision !== undefined && v.expectedRevision !== row.revision)
                throw new ConflictException('Assignment changed; refresh before review');
            if (row.status !== 'submitted')
                throw new ConflictException('Only a submitted assignment can be reviewed');
            await tx.query('UPDATE assignments SET status=$3,feedback=$4,reviewed_at=now(),reviewed_by=$5,updated_at=now(),revision=revision+1 WHERE business_id=$1 AND id=$2', [ctx.businessId, id, v.status, v.feedback, ctx.sub]);
            const updated = await this.assignment(tx, ctx, id);
            await this.assignmentEvent(tx, ctx, updated, 'learning.assignment-reviewed.v1');
            return {
                item: await this.assignmentDetail(tx, ctx, updated)
            };
        });
    }
    async listResources(ctx: RequestContext, query: unknown, portal = false) {
        const q = parseBody(resourceListSchema, query);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const clientId = q.clientId ? await authorizedStudent(tx, ctx, q.clientId) : null, scope = scopedIds(ctx), values = [ctx.businessId, clientId, scope];
            const where = `business_id=$1 AND ($2::uuid IS NULL OR client_id=$2) AND ($3::uuid[] IS NULL OR client_id=ANY($3::uuid[]))${portal ? " AND purpose='material'" : ''}`;
            const count = await tx.query<{
                total: string;
            }>(`SELECT count(*) total FROM resources WHERE ${where}`, values);
            const rows = await tx.query<ResourceRow>(`SELECT * FROM resources WHERE ${where} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`, [...values, q.limit, q.offset]);
            for (const row of rows.rows)
                assertStudentAccess(ctx, row.client_id);
            return {
                items: rows.rows.map(resourceView), total: Number(count.rows[0]!.total), limit: q.limit, offset: q.offset
            };
        });
    }
    async getResource(ctx: RequestContext, id: string) {
        return this.db.withTenant(ctx.businessId, async (tx) => ({
            item: resourceView(await this.resource(tx, ctx, id))
        }));
    }
    private async resource(tx: PoolClient, ctx: RequestContext, id: string) {
        parseBody(uuid, id);
        const rows = await tx.query<ResourceRow>('SELECT * FROM resources WHERE business_id=$1 AND id=$2', [ctx.businessId, id]);
        const row = rows.rows[0];
        if (!row)
            throw new NotFoundException('Resource not found');
        assertStudentAccess(ctx, row.client_id);
        return row;
    }
    async createResource(ctx: RequestContext, body: unknown) {
        const v = parseBody(resourceSchema, body);
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockLearning(tx, ctx.businessId);
            const clientId = await authorizedStudent(tx, ctx, v.clientId), linked = v.kind === 'link' || v.kind === 'google_doc';
            const rows = await tx.query<ResourceRow>('INSERT INTO resources(id,business_id,client_id,title,kind,url,file_name,mime_type,size_bytes,storage_status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [randomUUID(), ctx.businessId, clientId, v.title, v.kind, linked ? v.url : null, v.kind === 'file_metadata' ? v.fileName : null, v.kind === 'file_metadata' ? v.mimeType ?? null : null, v.kind === 'file_metadata' ? v.sizeBytes ?? null : null, linked ? 'linked' : 'upload_pending', ctx.sub]);
            await this.resourceEvent(tx, ctx, rows.rows[0]!);
            return {
                item: resourceView(rows.rows[0]!)
            };
        });
    }
    async uploadResource(ctx: RequestContext, body: unknown, file: UploadedResourceFile | undefined) {
        const v = parseBody(uploadSchema, body);
        assertStudentAccess(ctx, v.clientId);
        return this.persistUpload(ctx, v.title, file, v.clientId);
    }
    async uploadSubmission(ctx: RequestContext, id: string, body: unknown, file: UploadedResourceFile | undefined) {
        parseBody(uuid, id);
        const v = parseBody(submissionUploadSchema, body);
        return this.persistUpload(ctx, v.title, file, undefined, id);
    }
    private async persistUpload(ctx: RequestContext, title: string, file: UploadedResourceFile | undefined, clientId?: string, assignmentId?: string) {
        const validated = validateUpload(file), id = randomUUID(), storageKey = randomUUID(), storage = this.storageFactory();
        let stored = false;
        try {
            return await this.db.withTenant(ctx.businessId, async (tx) => {
                await lockLearning(tx, ctx.businessId);
                let target: string;
                if (assignmentId) {
                    const assignment = await this.assignment(tx, ctx, assignmentId, true);
                    if (!['assigned', 'needs_revision'].includes(assignment.status))
                        throw new ConflictException('Files can only be uploaded before submission');
                    target = assignment.client_id;
                    const pending = await tx.query<{
                        count: string;
                    }>('SELECT count(*) FROM resources WHERE submission_assignment_id=$1', [assignmentId]);
                    if (Number(pending.rows[0]!.count) >= 100)
                        throw new ConflictException('Assignment file limit reached');
                }
                else
                    target = await authorizedStudent(tx, ctx, clientId!);
                stored = true;
                await storage.put(ctx.businessId, storageKey, validated.buffer, validated.mimeType);
                const rows = await tx.query<ResourceRow>("INSERT INTO resources(id,business_id,client_id,title,kind,file_name,mime_type,size_bytes,storage_status,storage_key,created_by,purpose,submission_assignment_id) VALUES($1,$2,$3,$4,'file_metadata',$5,$6,$7,'stored',$8,$9,$10,$11) RETURNING *", [id, ctx.businessId, target, title, validated.fileName, validated.mimeType, validated.buffer.length, storageKey, ctx.sub, assignmentId ? 'submission' : 'material', assignmentId ?? null]);
                await this.resourceEvent(tx, ctx, rows.rows[0]!);
                return {
                    item: resourceView(rows.rows[0]!)
                };
            });
        }
        catch (error) {
            if (stored)
                try {
                    await storage.delete(ctx.businessId, storageKey);
                }
                catch {
                    console.error('[learning] private upload cleanup failed; orphan reconciliation required');
                }
            throw error;
        }
    }
    async downloadResource(ctx: RequestContext, id: string, response: Response) {
        const row = await this.db.withTenant(ctx.businessId, tx => this.resource(tx, ctx, id));
        if (row.storage_status !== 'stored' || !row.storage_key)
            throw new NotFoundException('Stored resource not found');
        const content = await this.storageFactory().read(ctx.businessId, parseBody(uuid, row.storage_key)), fileName = row.file_name || 'resource';
        const fallback = fileName.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/["\\]/g, '_');
        response.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
        response.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, v => `%${v.charCodeAt(0).toString(16).toUpperCase()}`)}`);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', 'private, no-store');
        if (row.size_bytes !== null)
            response.setHeader('Content-Length', row.size_bytes);
        return Buffer.isBuffer(content) ? new StreamableFile(content) : new StreamableFile(content);
    }
}
