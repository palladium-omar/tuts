import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Database, assertPermission, emitEvent, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { createContact, lockContacts, requireClient } from './contact-store.js';
import { normalizeName } from './student-identity.js';

const group = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(200) }).strict();
const uniqueKeys = (groups: { key: string }[]) => new Set(groups.map(value => value.key)).size === groups.length;
export const workImportPreviewSchema = z.object({ importId: z.uuid(), groups: z.array(group).min(1).max(100).refine(uniqueKeys, 'Group keys must be unique') }).strict();
const decision = group.extend({ action: z.enum(['create', 'link']), studentId: z.uuid().optional() }).strict()
  .refine(value => value.action === 'link' ? Boolean(value.studentId) : value.studentId === undefined, 'Only link decisions require a student ID');
export const workImportResolveSchema = z.object({ importId: z.uuid(), decisions: z.array(decision).min(1).max(100).refine(uniqueKeys, 'Group keys must be unique') }).strict();
type Decision = z.infer<typeof decision>;
type Mapping = { group_key: string; source_name: string; action: 'create' | 'link'; student_id: string; input_digest: string };

export function assertWorkImportAccess(ctx: RequestContext, write = false) {
  if (!['owner', 'admin', 'tutor'].includes(ctx.role) || ctx.accessScope === 'students') throw new ForbiddenException('Work import student review requires business access');
  if (!ctx.entitlements.includes('clients')) throw new ForbiddenException('Clients is not enabled for this business');
  assertPermission(ctx, 'clients.read');
  if (write) assertPermission(ctx, 'clients.write');
}
const digest = (value: Decision) => createHash('sha256').update(JSON.stringify([normalizeName(value.name), value.action, value.studentId ?? null])).digest('hex');

@Injectable()
export class WorkImportService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async preview(ctx: RequestContext, body: unknown) {
    assertWorkImportAccess(ctx);
    const input = parseBody(workImportPreviewSchema, body);
    return this.db.withTenant(ctx.businessId, async tx => {
      const mappings = await tx.query<Mapping>('SELECT group_key,source_name,action,student_id,input_digest FROM client_work_import_identities WHERE import_id=$1 AND group_key=ANY($2::text[])', [input.importId, input.groups.map(value => value.key)]);
      const byKey = new Map(mappings.rows.map(value => [value.group_key, value]));
      const names = [...new Set(input.groups.map(value => normalizeName(value.name)))];
      // Bound each name independently, even when a large tenant has many same-name students.
      const candidates = await tx.query<{ normalized_name: string; id: string; display_name: string; email: string | null; candidate_count: string }>(
        `SELECT requested.normalized_name,c.* FROM unnest($1::text[]) AS requested(normalized_name)
         CROSS JOIN LATERAL (SELECT id,display_name,email,count(*) OVER() candidate_count FROM clients
           WHERE kind='student' AND merged_into IS NULL AND normalized_name=requested.normalized_name ORDER BY id LIMIT 20) c`, [names]);
      const groups = [];
      for (const value of input.groups) {
        const mapping = byKey.get(value.key);
        if (mapping && normalizeName(mapping.source_name) !== normalizeName(value.name)) throw new ConflictException('work_import_identity_decision_conflict');
        const matches = candidates.rows.filter(candidate => candidate.normalized_name === normalizeName(value.name));
        const resolved = mapping ? await requireClient(tx, mapping.student_id) : null;
        if (resolved && resolved.kind !== 'student') throw new ConflictException('work_import_student_unavailable');
        groups.push({ key: value.key, name: value.name, candidates: matches.map(candidate => ({ id: candidate.id, displayName: candidate.display_name, email: candidate.email })), resolvedStudentId: resolved?.id ?? null, resolvedAction: mapping?.action ?? null, ambiguous: Number(matches[0]?.candidate_count ?? 0) > 1 });
      }
      return { groups };
    });
  }

  async resolve(ctx: RequestContext, body: unknown) {
    assertWorkImportAccess(ctx, true);
    const input = parseBody(workImportResolveSchema, body);
    return this.db.withTenant(ctx.businessId, async tx => {
      await lockContacts(tx, ctx.businessId);
      const mappings = await tx.query<Mapping>('SELECT group_key,source_name,action,student_id,input_digest FROM client_work_import_identities WHERE import_id=$1 AND group_key=ANY($2::text[]) FOR UPDATE', [input.importId, input.decisions.map(value => value.key)]);
      const byKey = new Map(mappings.rows.map(value => [value.group_key, value]));
      const groups = [];
      for (const value of input.decisions) {
        const mapping = byKey.get(value.key);
        const selected = value.action === 'link' ? await requireClient(tx, value.studentId!) : null;
        if (selected && selected.kind !== 'student') throw new ConflictException('Select a canonical CRM student');
        if (mapping) {
          const current = await requireClient(tx, mapping.student_id);
          if (current.kind !== 'student') throw new ConflictException('work_import_student_unavailable');
          // A merge may replace either the saved or requested ID. The original decision is retained.
          const aliasReplay = normalizeName(mapping.source_name) === normalizeName(value.name) && mapping.action === 'link' && value.action === 'link' && selected?.id === current.id;
          if (mapping.input_digest !== digest(value) && !aliasReplay) throw new ConflictException('work_import_identity_decision_conflict');
          groups.push({ key: value.key, studentId: current.id, created: mapping.action === 'create' });
          continue;
        }
        const student = selected ?? await createContact(tx, ctx.businessId, { kind: 'student', displayName: value.name, source: 'work-import' }, ctx.requestId);
        await tx.query(`INSERT INTO client_work_import_identities(business_id,import_id,group_key,source_name,action,student_id,input_digest,reviewed_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [ctx.businessId, input.importId, value.key, value.name, value.action, student.id, digest(value), ctx.sub]);
        await emitEvent(tx, { type: 'clients.work-import-resolved.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: { importId: input.importId, groupKey: value.key, studentId: student.id, action: value.action } });
        groups.push({ key: value.key, studentId: student.id, created: value.action === 'create' });
      }
      return { groups };
    });
  }
}
