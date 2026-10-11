import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { WorkImportService, workImportPreviewSchema, workImportResolveSchema } from '../src/work-import.js';
import { createContact } from '../src/contact-store.js';
import { ClientsController } from '../src/clients.controller.js';

const ctx: RequestContext = { businessId: randomUUID(), sub: 'synthetic-reviewer', role: 'owner', entitlements: ['clients'], requestId: randomUUID() };
const key = (value: number) => value.toString(16).padStart(64, '0');
const input = { importId: randomUUID(), groups: [{ key: key(1), name: 'Synthetic Student' }] };

test('work import schemas reject unbounded, duplicate, malformed and fabricated identity fields', () => {
  assert.equal(workImportPreviewSchema.safeParse(input).success, true);
  for (const groups of [[], Array.from({ length: 101 }, (_, i) => ({ key: key(i), name: 'Synthetic' })), [input.groups[0], input.groups[0]], [{ key: 'guess', name: 'Synthetic' }], [{ key: key(1), name: 'x'.repeat(201) }]]) {
    assert.equal(workImportPreviewSchema.safeParse({ ...input, groups }).success, false);
  }
  for (const value of [{ action: 'link' }, { action: 'create', studentId: randomUUID() }, { action: 'create', email: 'invented@example.test' }, { action: 'merge', studentId: randomUUID() }]) {
    assert.equal(workImportResolveSchema.safeParse({ importId: input.importId, decisions: [{ ...input.groups[0], ...value }] }).success, false);
  }
});

test('work import access fails before persistence for scoped students and missing capabilities', async () => {
  let calls = 0;
  const service = new WorkImportService({ withTenant: async () => { calls++; throw new Error('No access'); } } as unknown as Database);
  for (const denied of [{ ...ctx, role: 'student' as const }, { ...ctx, role: 'parent' as const }, { ...ctx, accessScope: 'students' as const }, { ...ctx, entitlements: [] }, { ...ctx, permissions: [] }]) {
    await assert.rejects(service.preview(denied, input));
    await assert.rejects(service.resolve(denied, { importId: input.importId, decisions: [{ ...input.groups[0], action: 'create' }] }));
  }
  await assert.rejects(service.resolve({ ...ctx, permissions: ['clients.read'] }, { importId: input.importId, decisions: [{ ...input.groups[0], action: 'create' }] }));
  assert.equal(calls, 0);
});

test('ordinary PostgreSQL work import retries preserve name-only profiles, decisions, aliases and tenant boundaries', { skip: !process.env.CLIENTS_TEST_DATABASE_URL }, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.CLIENTS_TEST_DATABASE_URL;
  const db = new Database();
  if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  const service = new WorkImportService(db), other = { ...ctx, businessId: randomUUID() };
  try {
    const role = (await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    const empty = await service.preview(ctx, input);
    assert.deepEqual(empty.groups[0], { ...input.groups[0], candidates: [], resolvedStudentId: null, resolvedAction: null, ambiguous: false });
    const request = { importId: input.importId, decisions: [{ ...input.groups[0], action: 'create' }] };
    const [created, concurrent] = await Promise.all([service.resolve(ctx, request), service.resolve(ctx, request)]);
    assert.deepEqual(created, concurrent);
    const studentId = created.groups[0]!.studentId;
    assert.equal(created.groups[0]!.created, true);
    assert.deepEqual(await service.resolve(ctx, request), created);
    await assert.rejects(new ClientsController(db).remove(ctx, studentId), (error: unknown) => {
      const conflict = error as { getStatus: () => number; message: string };
      assert.equal(conflict.getStatus(), 409);
      assert.match(conflict.message, /reviewed work imports.*inactive/);
      return true;
    });
    await new ClientsController(db).update(ctx, studentId, { status: 'inactive' });
    assert.deepEqual(await service.resolve(ctx, request), created);
    await new ClientsController(db).update(ctx, studentId, { status: 'lead' });
    await db.withTenant(ctx.businessId, async tx => {
      const student = (await tx.query('SELECT * FROM clients WHERE id=$1', [studentId])).rows[0];
      assert.equal(student.email, null); assert.equal(student.phone, null); assert.equal(student.status, 'lead');
      assert.equal(student.email_opt_in, false); assert.equal(student.whatsapp_opt_in, false); assert.equal(student.source, 'work-import');
      assert.equal(Number((await tx.query('SELECT count(*) FROM clients')).rows[0].count), 1);
      assert.equal(Number((await tx.query('SELECT count(*) FROM client_work_import_identities')).rows[0].count), 1);
      assert.ok((await tx.query("SELECT id FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='clients.work-import-resolved.v1'", [ctx.businessId])).rowCount);
    });
    assert.equal((await service.preview(ctx, input)).groups[0]!.resolvedStudentId, studentId);
    assert.equal((await service.preview(ctx, input)).groups[0]!.resolvedAction, 'create');
    await assert.rejects(service.resolve(ctx, { ...request, decisions: [{ ...request.decisions[0], name: 'Changed identity' }] }), /decision_conflict/);
    await assert.rejects(service.preview(ctx, { ...input, groups: [{ ...input.groups[0], name: 'Changed identity' }] }), /decision_conflict/);
    await assert.rejects(service.resolve(ctx, { ...request, decisions: [{ ...input.groups[0], action: 'link', studentId }] }), /decision_conflict/);
    const candidates = await db.withTenant(ctx.businessId, async tx => {
      const result = [];
      for (let i = 0; i < 22; i++) result.push(await createContact(tx, ctx.businessId, { kind: 'student', displayName: 'Repeated Name' }));
      return result;
    });
    const repeated = { importId: input.importId, groups: [{ key: key(2), name: '  Repeated   Name ' }] };
    const preview = await service.preview(ctx, repeated);
    assert.equal(preview.groups[0]!.candidates.length, 20); assert.equal(preview.groups[0]!.ambiguous, true);
    assert.equal(preview.groups[0]!.resolvedStudentId, null);
    const linkedRequest = { importId: input.importId, decisions: [{ key: key(2), name: 'Repeated   Name', action: 'link', studentId: candidates[0]!.id }] };
    const linked = await service.resolve(ctx, linkedRequest);
    assert.equal(linked.groups[0]!.created, false);
    assert.equal((await service.preview(ctx, repeated)).groups[0]!.resolvedAction, 'link');
    await db.withTenant(ctx.businessId, tx => tx.query('UPDATE clients SET merged_into=$2 WHERE id=$1', [candidates[0]!.id, candidates[1]!.id]));
    const scoped: RequestContext = { ...ctx, role: 'tutor', accessScope: 'students', studentIds: [candidates[0]!.id, candidates[1]!.id], permissions: ['clients.read'] };
    assert.deepEqual(await new ClientsController(db).identity(scoped, candidates[0]!.id), { item: { id: candidates[1]!.id, kind: 'student' } });
    await assert.rejects(new ClientsController(db).identity({ ...scoped, studentIds: [candidates[0]!.id] }, candidates[0]!.id), /Student access is not granted/);
    await assert.rejects(new ClientsController(db).identity({ ...scoped, studentIds: [candidates[1]!.id] }, candidates[0]!.id), /Student access is not granted/);
    await assert.rejects(new ClientsController(db).identity({ ...other, permissions: ['clients.read'] }, studentId), /not found/);
    assert.equal((await service.resolve(ctx, linkedRequest)).groups[0]!.studentId, candidates[1]!.id);
    assert.equal((await service.resolve(ctx, { ...linkedRequest, decisions: [{ ...linkedRequest.decisions[0], studentId: candidates[1]!.id }] })).groups[0]!.studentId, candidates[1]!.id);
    assert.equal((await service.preview(ctx, { ...repeated, groups: [{ ...repeated.groups[0], name: 'Repeated   Name' }] })).groups[0]!.resolvedStudentId, candidates[1]!.id);
    await assert.rejects(service.resolve(ctx, { ...linkedRequest, decisions: [{ ...linkedRequest.decisions[0], studentId: candidates[2]!.id }] }), /decision_conflict/);
    assert.deepEqual((await service.preview(other, input)).groups[0]!.candidates, []);
    await assert.rejects(service.resolve(other, { importId: input.importId, decisions: [{ ...input.groups[0], action: 'link', studentId }] }), /not found/);
    await db.withTenant(other.businessId, async tx => {
      assert.equal((await tx.query('SELECT * FROM client_work_import_identities WHERE import_id=$1', [input.importId])).rowCount, 0);
      await tx.query('SAVEPOINT mismatched');
      await assert.rejects(tx.query(`INSERT INTO client_work_import_identities(business_id,import_id,group_key,source_name,action,student_id,input_digest,reviewed_by) VALUES($1,$2,$3,'Synthetic','create',$4,$3,'synthetic')`, [ctx.businessId, input.importId, key(9), studentId]), (error: unknown) => (error as { code: string }).code === '42501');
      await tx.query('ROLLBACK TO SAVEPOINT mismatched');
    });
    const payer = await db.withTenant(ctx.businessId, tx => createContact(tx, ctx.businessId, { kind: 'payer', displayName: 'Synthetic Payer' }));
    await assert.rejects(service.resolve(ctx, { importId: input.importId, decisions: [{ key: key(3), name: 'Synthetic Payer', action: 'link', studentId: payer.id }] }), /canonical CRM student/);
    assert.equal((await new ClientsController(db).remove(ctx, payer.id)).item.deleted, true);
    // A later bad decision rolls back both the earlier name-only profile and its outbox/mapping.
    await assert.rejects(service.resolve(ctx, { importId: input.importId, decisions: [{ key: key(4), name: 'Rolled back student', action: 'create' }, { key: key(5), name: 'Bad link', action: 'link', studentId: randomUUID() }] }));
    await db.withTenant(ctx.businessId, async tx => {
      assert.equal((await tx.query("SELECT id FROM clients WHERE display_name='Rolled back student'")).rowCount, 0);
      assert.equal((await tx.query('SELECT group_key FROM client_work_import_identities WHERE group_key=$1', [key(4)])).rowCount, 0);
    });
  } finally {
    for (const business of [ctx.businessId, other.businessId]) await db.withTenant(business, async tx => {
      await tx.query('DELETE FROM client_work_import_identities');
      await tx.query('DELETE FROM clients');
      await tx.query('DELETE FROM contact_addresses');
      await tx.query('DELETE FROM related_contacts');
      await tx.query("DELETE FROM service_outbox WHERE event->>'businessId'=$1", [business]);
    });
    await db.pool.end();
  }
});
