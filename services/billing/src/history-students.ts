import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Database, assertPermission, emitEvent, parseBody, serviceFetch } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertHistoryAccess, dayView, sourceRecord } from './history.js';
import { identityView } from './history-identity.js';
import { requestHash } from './idempotency.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const groupKey = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().trim().min(1).max(200);
const revision = z.number().int().positive().max(2147483647);
const reviewGroup = z.object({
  key: groupKey, name, action: z.enum(['create', 'link']), studentId: uuid.optional(),
  rows: z.array(z.object({ id: uuid, revision, identityRevision: revision.or(z.literal(0)) }).strict()).min(1).max(1000),
}).strict().refine(group => group.action === 'link' ? Boolean(group.studentId) : group.studentId === undefined, 'Select a student only for a link decision');
export const importStudentsSchema = z.object({ groups: z.array(reviewGroup).min(1).max(100) }).strict()
  .refine(input => input.groups.reduce((total, group) => total + group.rows.length, 0) <= 1000, 'Review at most 1000 rows at once')
  .refine(input => new Set(input.groups.map(group => group.key)).size === input.groups.length, 'Group keys must be unique')
  .refine(input => { const ids = input.groups.flatMap(group => group.rows.map(row => row.id)); return new Set(ids).size === ids.length; }, 'Review each work row once');
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(1000), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict();
const resolutionSchema = z.object({ item: z.object({ groups: z.array(z.object({ key: groupKey, studentId: uuid, created: z.boolean() })).max(100) }) });
type ReviewGroup = z.infer<typeof reviewGroup>;
type RowRevision = { id: string; revision: number; identityRevision: number };
type GroupResult = { key: string; studentId: string; created: boolean; rows: RowRevision[] };
type WorkRow = Record<string, any>;
export const normalizeImportStudentName = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
export const importStudentGroupKey = (ids: string[]) => createHash('sha256').update(ids.map(id => id.toLowerCase()).sort().join('\n')).digest('hex');
const digest = (group: ReviewGroup) => requestHash({ ...group, name: normalizeImportStudentName(group.name), rows: [...group.rows].sort((a, b) => a.id.localeCompare(b.id)) });
const selection = `SELECT w.*,i.status identity_status,billing_student_root(i.student_id) identity_student_id,
 i.work_revision identity_work_revision,i.revision identity_revision,i.reason identity_reason,i.reviewed_at identity_reviewed_at
 FROM billing_work_log w LEFT JOIN billing_work_identities i ON i.business_id=w.business_id AND i.work_id=w.id`;

function assertImportAccess(ctx: RequestContext, write = false) {
  assertHistoryAccess(ctx, write);
  assertPermission(ctx, 'clients.read');
  if (write) assertPermission(ctx, 'clients.write');
  if (!ctx.entitlements.includes('billing') || !ctx.entitlements.includes('clients')) throw new ForbiddenException('Billing and Clients must be enabled for this business');
}

@Injectable()
export class HistoryStudentsService {
  constructor(@Inject(Database) private readonly db: Database) {}
  fetchClients: typeof serviceFetch = serviceFetch;

  private async source(tx: PoolClient, businessId: string, id: string) {
    const source = (await tx.query('SELECT id,file_name,kind,content_type,octet_length(file_bytes) size_bytes,created_at,committed_at,preview FROM billing_history_sources WHERE business_id=$1 AND id=$2', [businessId, id])).rows[0];
    if (!source) throw new NotFoundException('history_source_not_found');
    if (source.kind !== 'work' || !source.committed_at) throw new BadRequestException('Student review requires a committed work source');
    return source;
  }

  async students(ctx: RequestContext, rawId: string, query: unknown) {
    assertImportAccess(ctx);
    const id = parseBody(uuid, rawId), input = parseBody(querySchema, query);
    return this.db.withTenant(ctx.businessId, async tx => {
      const source = await this.source(tx, ctx.businessId, id);
      const total = Number((await tx.query('SELECT count(*) total FROM billing_work_log WHERE business_id=$1 AND import_id=$2', [ctx.businessId, id])).rows[0].total);
      const rows = (await tx.query(`${selection} WHERE w.business_id=$1 AND w.import_id=$2 ORDER BY w.source_row,w.id LIMIT $3 OFFSET $4`, [ctx.businessId, id, input.limit, input.offset])).rows;
      const groups = new Map<string, { key: string; name: string; normalizedName: string; rows: Array<RowRevision & { date: string; studentName: string; serviceType: string; hours: number; identity: ReturnType<typeof identityView> }> }>();
      for (const row of rows) {
        const normalizedName = normalizeImportStudentName(row.student_name);
        let group = groups.get(normalizedName);
        if (!group) { group = { key: '', name: row.student_name, normalizedName, rows: [] }; groups.set(normalizedName, group); }
        group.rows.push({ id: row.id, revision: row.revision, identityRevision: Number(row.identity_revision ?? 0), date: dayView(row.work_date), studentName: row.student_name, serviceType: row.service_type, hours: Number(row.hours), identity: identityView(row, row.revision) });
      }
      for (const group of groups.values()) group.key = importStudentGroupKey(group.rows.map(row => row.id));
      return { source: sourceRecord(source), groups: [...groups.values()], total, ...input };
    }, { isolation: 'repeatable read' });
  }

  private async validate(tx: PoolClient, ctx: RequestContext, id: string, groups: ReviewGroup[], locked = false) {
    await this.source(tx, ctx.businessId, id);
    const ids = groups.flatMap(group => group.rows.map(row => row.id));
    const rows = (await tx.query(`${selection} WHERE w.business_id=$1 AND w.import_id=$2 AND w.id=ANY($3::uuid[]) ORDER BY w.id${locked ? ' FOR UPDATE OF w' : ''}`, [ctx.businessId, id, ids])).rows as WorkRow[];
    if (rows.length !== ids.length) throw new NotFoundException('work_import_row_not_found');
    const byId = new Map(rows.map(row => [row.id, row]));
    const saved = (await tx.query('SELECT group_key,request_hash,result FROM billing_work_import_student_reviews WHERE business_id=$1 AND import_id=$2 AND group_key=ANY($3::text[])', [ctx.businessId, id, groups.map(group => group.key)])).rows;
    const receipts = new Map(saved.map(row => [row.group_key, row]));
    const completed = new Map<string, GroupResult>();
    for (const group of groups) {
      if (importStudentGroupKey(group.rows.map(row => row.id)) !== group.key) throw new BadRequestException('work_import_group_key_mismatch');
      for (const expected of group.rows) {
        const row = byId.get(expected.id)!;
        if (normalizeImportStudentName(row.student_name) !== normalizeImportStudentName(group.name)) throw new ConflictException('work_import_student_name_conflict');
        if (row.revision !== expected.revision) throw new ConflictException('work_log_revision_conflict');
      }
      const receipt = receipts.get(group.key);
      if (receipt) {
        if (receipt.request_hash !== digest(group)) throw new ConflictException('work_import_decision_conflict');
        const result = receipt.result as GroupResult;
        const canonical = (await tx.query('SELECT billing_student_root($1) id', [result.studentId])).rows[0].id as string;
        for (const applied of result.rows) {
          const row = byId.get(applied.id)!;
          if (row.revision !== applied.revision || Number(row.identity_revision ?? 0) !== applied.identityRevision || row.identity_status !== 'linked' || Number(row.identity_work_revision) !== row.revision || row.identity_student_id !== canonical) throw new ConflictException('identity_review_revision_conflict');
        }
        completed.set(group.key, { ...result, studentId: canonical });
      } else {
        for (const expected of group.rows) if (Number(byId.get(expected.id)!.identity_revision ?? 0) !== expected.identityRevision) throw new ConflictException('identity_review_revision_conflict');
      }
    }
    return { byId, completed };
  }

  private async resolve(id: string, groups: ReviewGroup[], authorization: string) {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = async () => {
        const response = await this.fetchClients('clients', '/v1/clients/work-import/resolve', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ importId: id, decisions: groups.map(({ key, name, action, studentId }) => ({ key, name, action, ...(studentId ? { studentId } : {}) })) }), signal: controller.signal });
        if (controller.signal.aborted) { await response.body?.cancel(); throw new ServiceUnavailableException('Student resolution unavailable; retry the same choices'); }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 409) throw new ConflictException('work_import_client_decision_conflict');
          if (response.status === 403) throw new ForbiddenException('Clients student resolution is not permitted');
          if ([400, 404, 422].includes(response.status)) throw new BadRequestException('Review the selected CRM students and source names');
          throw new ServiceUnavailableException('Student resolution unavailable; retry the same choices');
        }
        if (!response.body) throw new ServiceUnavailableException('Student resolution unavailable; retry the same choices');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.length; if (size > 262144) throw new ServiceUnavailableException('Student resolution response exceeds limit');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (controller.signal.aborted) throw new ServiceUnavailableException('Student resolution unavailable; retry the same choices');
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceUnavailableException('Student resolution response is invalid'); }
        const result = resolutionSchema.safeParse(parsed);
        if (!result.success || result.data.item.groups.length !== groups.length || new Set(result.data.item.groups.map(group => group.key)).size !== groups.length || result.data.item.groups.some(group => !groups.some(expected => expected.key === group.key))) throw new ServiceUnavailableException('Student resolution response is invalid');
        return result.data.item.groups;
      };
      return await Promise.race([request(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          reject(new ServiceUnavailableException('Student resolution unavailable; retry the same choices'));
        }, 8000);
      })]);
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Student resolution unavailable; retry the same choices');
    } finally { if (timer) clearTimeout(timer); }
  }

  async review(ctx: RequestContext, rawId: string, body: unknown, authorization: unknown) {
    assertImportAccess(ctx, true);
    const id = parseBody(uuid, rawId), input = parseBody(importStudentsSchema, body);
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) throw new BadRequestException('Verified authorization required');
    const before = await this.db.withTenant(ctx.businessId, tx => this.validate(tx, ctx, id, input.groups));
    const pending = input.groups.filter(group => !before.completed.has(group.key));
    // No transaction is open during contact creation. The durable Clients mapping
    // makes retry safe if Billing fails after this request succeeds.
    const resolved = pending.length ? await this.resolve(id, pending, authorization) : [];
    return this.db.withTenant(ctx.businessId, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`monthly:${ctx.businessId}`]);
      const current = await this.validate(tx, ctx, id, input.groups, true);
      const results: GroupResult[] = []; let linked = 0, replayed = 0;
      for (const group of input.groups) {
        const complete = current.completed.get(group.key);
        if (complete) { results.push(complete); replayed += complete.rows.length; continue; }
        const decision = resolved.find(result => result.key === group.key);
        if (!decision) throw new ConflictException('work_import_decision_conflict');
        const studentId = (await tx.query('SELECT billing_student_root($1) id', [decision.studentId])).rows[0].id as string;
        const records = group.rows.map(row => ({ work_id: row.id, work_revision: row.revision }));
        const applied = await tx.query(`INSERT INTO billing_work_identities(business_id,work_id,student_id,status,work_revision,reason,reviewed_by)
          SELECT $1,data.work_id,$3,'linked',data.work_revision,$4,$5 FROM jsonb_to_recordset($2::jsonb) AS data(work_id uuid,work_revision integer)
          ON CONFLICT(business_id,work_id) DO UPDATE SET student_id=EXCLUDED.student_id,status='linked',work_revision=EXCLUDED.work_revision,reason=EXCLUDED.reason,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now(),revision=billing_work_identities.revision+1
          RETURNING work_id,work_revision,revision`, [ctx.businessId, JSON.stringify(records), studentId, `Work import review: ${group.key}`, ctx.sub]);
        const result: GroupResult = { key: group.key, studentId, created: decision.created, rows: applied.rows.map(row => ({ id: row.work_id, revision: row.work_revision, identityRevision: row.revision })) };
        await tx.query('INSERT INTO billing_work_import_student_reviews(business_id,import_id,group_key,request_hash,result,reviewed_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [ctx.businessId, id, group.key, digest(group), JSON.stringify(result), ctx.sub]);
        for (const row of result.rows) await emitEvent(tx, { type: 'billing.work-history-updated.v1', producer: 'billing', businessId: ctx.businessId, correlationId: ctx.requestId, data: { id: row.id, identityRevision: row.identityRevision, importId: id } });
        linked += result.rows.length; results.push(result);
      }
      return { importId: id, linked, created: results.filter(group => group.created && !current.completed.has(group.key)).length, replayed, groups: results };
    });
  }
}
