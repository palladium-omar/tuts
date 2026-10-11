import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { HistoryService } from '../src/history.js';
import { HistoryStudentsService, importStudentGroupKey, normalizeImportStudentName } from '../src/history-students.js';
import { HistoryStudentsController } from '../src/history-students.controller.js';

const permissions = ['billing.read', 'billing.write', 'reporting.financial', 'clients.read', 'clients.write'];
const context = (): RequestContext => ({ businessId: randomUUID(), sub: 'synthetic-work-import-reviewer', role: 'owner', accessScope: 'business', policyVersion: 1, studentIds: [], permissions, entitlements: ['billing', 'clients'], requestId: randomUUID() });
type Group = { key: string; name: string; action: 'create' | 'link'; studentId?: string; rows: Array<{ id: string; revision: number; identityRevision: number }> };
const decision = (group: { key: string; name: string; rows: Array<{ id: string; revision: number; identityRevision: number }> }, studentId?: string): Group => ({ key: group.key, name: group.name, action: studentId ? 'link' : 'create', ...(studentId ? { studentId } : {}), rows: group.rows.map(({ id, revision, identityRevision }) => ({ id, revision, identityRevision })) });

test('work-import review enforces business capabilities and bounded explicit row decisions before IO', async () => {
  let writes = 0, requests = 0;
  const service = new HistoryStudentsService({ withTenant: async () => { writes++; throw new Error('Unexpected database request'); } } as unknown as Database);
  service.fetchClients = async () => { requests++; throw new Error('Unexpected Clients request'); };
  const ctx = context(), id = randomUUID(), row = { id: randomUUID(), revision: 1, identityRevision: 0 };
  const group: Group = { key: importStudentGroupKey([row.id]), name: 'Synthetic Student', action: 'create', rows: [row] };
  for (const denied of [
    { ...ctx, role: 'student' as const }, { ...ctx, role: 'parent' as const }, { ...ctx, role: 'tutor' as const, accessScope: 'students' as const },
    ...permissions.map(permission => ({ ...ctx, permissions: permissions.filter(value => value !== permission) })),
    { ...ctx, entitlements: ['billing'] }, { ...ctx, entitlements: ['clients'] },
  ]) await assert.rejects(service.review(denied, id, { groups: [group] }, 'Bearer synthetic'));
  for (const body of [{ groups: [] }, { groups: [group, group] }, { groups: [{ ...group, action: 'link' }] }, { groups: [{ ...group, studentId: randomUUID() }] }, { groups: [{ ...group, rows: [row, row] }] }, { groups: [{ ...group, rows: Array.from({ length: 1001 }, () => ({ ...row, id: randomUUID() })) }] }, { groups: Array.from({ length: 101 }, () => ({ ...group, key: importStudentGroupKey([randomUUID()]) })) }]) await assert.rejects(service.review(ctx, id, body, 'Bearer synthetic'));
  await assert.rejects(service.review(ctx, id, { groups: [group] }, undefined), /Verified authorization/);
  await assert.rejects(service.students({ ...ctx, permissions: ['billing.read', 'reporting.financial'] }, id, {}));
  assert.equal(writes, 0); assert.equal(requests, 0);
  assert.equal(normalizeImportStudentName('  Ｓｙｎｔｈｅｔｉｃ\tStudent  '), 'synthetic student');
  assert.equal(importStudentGroupKey([row.id.toUpperCase(), id]), importStudentGroupKey([id, row.id]));
});

test('work-import routes require business financial and Clients capabilities', () => {
  const reflector = new Reflector();
  assert.deepEqual(reflector.get('palladium.roles', HistoryStudentsController), ['owner', 'admin', 'tutor']);
  assert.equal(reflector.get('palladium.student-scoped', HistoryStudentsController), undefined);
  assert.deepEqual(reflector.get('palladium.permissions', HistoryStudentsController), ['billing.read', 'reporting.financial', 'clients.read']);
  assert.deepEqual(reflector.get('palladium.permissions', HistoryStudentsController.prototype.review), ['billing.read', 'billing.write', 'reporting.financial', 'clients.read', 'clients.write']);
});

test('Clients resolution cancels rejected response bodies while preserving status meanings', async () => {
  const service = new HistoryStudentsService({} as Database);
  const resolve = (service as unknown as { resolve(id: string, groups: Group[], authorization: string): Promise<unknown> }).resolve.bind(service);
  for (const [status, message] of [[409, 'client_decision_conflict'], [403, 'not permitted'], [400, 'selected CRM students'], [404, 'selected CRM students'], [422, 'selected CRM students'], [503, 'Student resolution unavailable']] as const) {
    let cancellations = 0;
    const response = new Response(new ReadableStream({ start() {}, cancel() { cancellations++; } }), { status });
    service.fetchClients = async () => response;
    await assert.rejects(resolve(randomUUID(), [], 'Bearer synthetic'), new RegExp(message));
    assert.equal(cancellations, 1); assert.equal(response.body!.locked, false);
  }
});

test('Clients resolution deadline cancels a stalled body even when a binding ignores abort', async () => {
  const service = new HistoryStudentsService({} as Database);
  const resolve = (service as unknown as { resolve(id: string, groups: Group[], authorization: string): Promise<unknown> }).resolve.bind(service);
  const lateService = new HistoryStudentsService({} as Database);
  const resolveLate = (lateService as unknown as { resolve(id: string, groups: Group[], authorization: string): Promise<unknown> }).resolve.bind(lateService);
  let cancellations = 0, signal: AbortSignal | null | undefined;
  let lateCancellations = 0, completeLate: ((response: Response) => void) | undefined;
  const response = new Response(new ReadableStream({ start() {}, cancel() { cancellations++; } }));
  service.fetchClients = async (_service, _path, init) => { signal = init?.signal; return response; };
  lateService.fetchClients = async () => new Promise<Response>(complete => { completeLate = complete; });
  const started = Date.now();
  await Promise.all([
    assert.rejects(resolve(randomUUID(), [], 'Bearer synthetic'), /Student resolution unavailable; retry the same choices/),
    assert.rejects(resolveLate(randomUUID(), [], 'Bearer synthetic'), /Student resolution unavailable; retry the same choices/),
  ]);
  const lateResponse = new Response(new ReadableStream({ start() {}, cancel() { lateCancellations++; } }));
  completeLate!(lateResponse);
  await new Promise<void>(settled => setImmediate(settled));
  assert.ok(Date.now() - started < 11000, 'The eight-second deadline must include body consumption');
  assert.equal(signal?.aborted, true); assert.equal(cancellations, 1);
  assert.equal(response.body!.locked, false, 'The stalled reader must release its response lock');
  assert.equal(lateCancellations, 1); assert.equal(lateResponse.body!.locked, false, 'A response arriving after the deadline must not leave an unconsumed body');
});

test('actual tenant transactions repair saved work, recover contact-side commits, replay without duplicates, preserve values and reject stale or cross-tenant identities', { skip: !process.env.BILLING_TEST_DATABASE_URL }, async () => {
  const db = new Database(), ctx = context(), other = { ...ctx, businessId: randomUUID() };
  await db.pool.end();
  Object.defineProperty(db, 'pool', { value: new Pool({ connectionString: process.env.BILLING_TEST_DATABASE_URL }) });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const tokenInput = `${jwtPart({ alg: 'EdDSA', typ: 'JWT' })}.${jwtPart({ ...ctx, iss: 'palladium-gateway', aud: 'palladium-services', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 })}`;
  const authorization = `Bearer ${tokenInput}.${sign(null, Buffer.from(tokenInput), privateKey).toString('base64url')}`;
  let depth = 0;
  const scoped = { withTenant: async <T>(businessId: string, work: Parameters<Database['withTenant']>[1], options?: Parameters<Database['withTenant']>[2]): Promise<T> => {
    depth++;
    try { return await db.withTenant(businessId, work, options) as T; } finally { depth--; }
  } } as Database;
  const history = new HistoryService(db), service = new HistoryStudentsService(scoped);
  const mappings = new Map<string, { key: string; studentId: string; created: boolean }>();
  let requests = 0, creations = 0, failAfterClients = false;
  service.fetchClients = async (_service, path, init) => {
    assert.equal(depth, 0, 'No Billing transaction may remain open across Clients HTTP');
    assert.equal(path, '/v1/clients/work-import/resolve');
    const forwarded = new Headers(init?.headers).get('authorization')!;
    assert.equal(forwarded, authorization);
    const parts = forwarded.slice(7).split('.');
    assert.ok(verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url')));
    assert.equal(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()).businessId, ctx.businessId);
    const input = JSON.parse(String(init?.body)); requests++;
    const groups = input.decisions.map((group: Group) => {
      let resolved = mappings.get(group.key);
      if (!resolved) {
        resolved = { key: group.key, studentId: group.studentId ?? randomUUID(), created: group.action === 'create' };
        if (resolved.created) creations++;
        // Name-only contact creation: no inferred email, consent or portal state.
        assert.equal('email' in group, false); mappings.set(group.key, resolved);
      }
      return resolved;
    });
    if (failAfterClients) {
      failAfterClients = false;
      const original = scoped.withTenant.bind(scoped);
      scoped.withTenant = async () => { scoped.withTenant = original; throw new Error('Synthetic post-Clients Billing failure'); };
    }
    return new Response(JSON.stringify({ item: { groups } }));
  };
  try {
    const role = (await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    await db.migrate(fileURLToPath(new URL('../migrations', import.meta.url)));
    const bytes = Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Invoice Status\n2026-09-01,Synthetic Student,1.5,40,Paid\n2026-10-01,synthetic  student,2,40,Pending\n2026-10-02,Synthetic Other,0.25,40,Sent');
    const preview = await history.preview(ctx, { originalname: 'name-only-work.csv', buffer: bytes }, { kind: 'work', currency: 'EUR' });
    const committed = await history.commit(ctx, { token: preview.token }, 'synthetic-work-commit');
    assert.equal(committed.imported, 3);
    const initial = await service.students(ctx, preview.importId, {});
    assert.equal(initial.source.status, 'committed'); assert.equal(initial.groups.length, 2); assert.equal(initial.total, 3);
    assert.deepEqual(initial.groups.map(group => group.rows.length).sort(), [1, 2]);
    const firstPage = await service.students(ctx, preview.importId, { limit: 1 }), secondPage = await service.students(ctx, preview.importId, { limit: 1, offset: 1 });
    assert.equal(firstPage.total, 3); assert.notEqual(firstPage.groups[0]!.rows[0]!.id, secondPage.groups[0]!.rows[0]!.id);
    const originalRows = (await history.workLog(ctx, { limit: 200 })).items;
    const grouped = initial.groups.find(group => group.rows.length === 2)!;
    const body = { groups: [decision(grouped)] };
    await assert.rejects(service.students(other, preview.importId, {}), /history_source_not_found/);
    await assert.rejects(service.review(other, preview.importId, body, authorization), /history_source_not_found/);
    await assert.rejects(service.review(ctx, preview.importId, { groups: [{ ...body.groups[0]!, key: '0'.repeat(64) }] }, authorization), /group_key_mismatch/);
    await assert.rejects(service.review(ctx, preview.importId, { groups: [{ ...body.groups[0]!, name: 'Wrong Student' }] }, authorization), /student_name_conflict/);
    const outsider = { id: randomUUID(), revision: 1, identityRevision: 0 };
    await assert.rejects(service.review(ctx, preview.importId, { groups: [{ ...body.groups[0]!, rows: [outsider], key: importStudentGroupKey([outsider.id]) }] }, authorization), /work_import_row_not_found/);
    assert.equal(requests, 0);
    const unavailable = new HistoryStudentsService(db);
    for (const [status, message] of [[409, 'client_decision_conflict'], [403, 'not permitted'], [400, 'selected CRM students'], [404, 'selected CRM students'], [503, 'Student resolution unavailable']] as const) {
      unavailable.fetchClients = async () => new Response('{}', { status });
      await assert.rejects(unavailable.review(ctx, preview.importId, body, authorization), new RegExp(message));
    }
    for (const response of [new Response('not JSON'), new Response(JSON.stringify({ item: { groups: [] } })), new Response(JSON.stringify({ item: { groups: [{ key: 'f'.repeat(64), studentId: randomUUID(), created: true }] } })), new Response('x'.repeat(262145))]) {
      unavailable.fetchClients = async () => response;
      await assert.rejects(unavailable.review(ctx, preview.importId, body, authorization), /Student resolution response/);
    }
    unavailable.fetchClients = async () => { throw new Error('Private upstream credential must not appear'); };
    await assert.rejects(unavailable.review(ctx, preview.importId, body, authorization), error => error instanceof Error && error.message === 'Student resolution unavailable; retry the same choices');
    assert.equal((await service.students(ctx, preview.importId, {})).groups.flatMap(group => group.rows).filter(row => row.identity.status === 'linked').length, 0);
    failAfterClients = true;
    await assert.rejects(service.review(ctx, preview.importId, body, authorization), /Synthetic post-Clients Billing failure/);
    assert.equal(creations, 1); assert.equal((await service.students(ctx, preview.importId, {})).groups.flatMap(group => group.rows).filter(row => row.identity.status === 'linked').length, 0);
    const repaired = await service.review(ctx, preview.importId, body, authorization);
    assert.equal(repaired.linked, 2); assert.equal(repaired.created, 1); assert.equal(repaired.replayed, 0); assert.equal(creations, 1); assert.equal(requests, 2);
    const eventCount = await db.withTenant(ctx.businessId, async tx => Number((await tx.query("SELECT count(*) total FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='billing.work-history-updated.v1'", [ctx.businessId])).rows[0].total));
    const replay = await service.review(ctx, preview.importId, body, authorization);
    assert.equal(replay.linked, 0); assert.equal(replay.created, 0); assert.equal(replay.replayed, 2); assert.equal(requests, 2);
    assert.equal(await db.withTenant(ctx.businessId, async tx => Number((await tx.query("SELECT count(*) total FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='billing.work-history-updated.v1'", [ctx.businessId])).rows[0].total)), eventCount);
    const target = randomUUID();
    await db.withTenant(ctx.businessId, tx => tx.query('INSERT INTO billing_student_aliases(business_id,source_id,target_id) VALUES($1,$2,$3)', [ctx.businessId, repaired.groups[0]!.studentId, target]));
    assert.equal((await service.review(ctx, preview.importId, body, authorization)).groups[0]!.studentId, target);
    const leftover = initial.groups.find(group => group.rows.length === 1)!;
    const remaining = await service.review(ctx, preview.importId, { groups: [decision(leftover, target)] }, authorization);
    assert.equal(remaining.linked, 1); assert.equal(remaining.created, 0); assert.equal(creations, 1);
    const afterRows = (await history.workLog(ctx, { limit: 200 })).items;
    for (const row of originalRows) {
      const after = afterRows.find(value => value.id === row.id)!;
      for (const field of ['revision', 'date', 'studentName', 'hours', 'rateMinor', 'amountMinor', 'status', 'countAsClasses'] as const) assert.equal(after[field], row[field]);
      assert.equal(after.identity.status, 'linked'); assert.equal(after.identity.studentId, target);
    }
    assert.deepEqual((await history.download(ctx, preview.importId)).file_bytes, bytes);
    assert.equal((await history.commit(ctx, { token: preview.token }, 'replay-work-commit')).imported, 3);
    await db.withTenant(ctx.businessId, async tx => {
      assert.equal((await tx.query('SELECT count(*) total FROM billing_work_log')).rows[0].total, '3');
      assert.equal((await tx.query('SELECT count(*) total FROM invoices')).rows[0].total, '0');
      assert.equal((await tx.query('SELECT count(*) total FROM billing_classes')).rows[0].total, '0');
      assert.equal((await tx.query('SELECT count(*) total FROM billing_invoice_history')).rows[0].total, '0');
      const row = (await tx.query('SELECT reviewed_by FROM billing_work_import_student_reviews LIMIT 1')).rows[0]; assert.equal(row.reviewed_by, ctx.sub);
    });
    await assert.rejects(service.review(ctx, preview.importId, { groups: [{ ...body.groups[0]!, action: 'link', studentId: target }] }, authorization), /work_import_decision_conflict/);
    await db.withTenant(ctx.businessId, tx => tx.query('UPDATE billing_work_identities SET revision=revision+1 WHERE work_id=$1', [grouped.rows[0]!.id]));
    await assert.rejects(service.review(ctx, preview.importId, body, authorization), /identity_review_revision_conflict/);
    await history.editWork(ctx, grouped.rows[0]!.id, { notes: 'Reviewed source correction', revision: 1 });
    await assert.rejects(service.review(ctx, preview.importId, body, authorization), /work_log_revision_conflict/);
    const fresh = { groups: [{ ...body.groups[0]!, rows: body.groups[0]!.rows.map(row => ({ ...row, revision: row.id === grouped.rows[0]!.id ? 2 : 1 })) }] };
    await assert.rejects(service.review(ctx, preview.importId, fresh, authorization), /work_import_decision_conflict/);
    const archive = await history.preview(ctx, { originalname: 'synthetic.pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic') }, { kind: 'archive' });
    await history.commit(ctx, { token: archive.token }, 'synthetic-archive');
    await assert.rejects(service.students(ctx, archive.importId, {}), /committed work source/);
    const staged = await history.preview(ctx, { originalname: 'staged.csv', buffer: Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Invoice Status\n2026-10-03,Staged Synthetic,1,40,Paid') }, { kind: 'work', currency: 'EUR' });
    await assert.rejects(service.students(ctx, staged.importId, {}), /committed work source/);
    const racing = await history.preview(ctx, { originalname: 'racing.csv', buffer: Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Invoice Status\n2026-10-04,Racing Synthetic A,1,40,Paid\n2026-10-05,Racing Synthetic B,1,40,Paid') }, { kind: 'work', currency: 'EUR' });
    await history.commit(ctx, { token: racing.token }, 'synthetic-racing');
    const raceRows = await service.students(ctx, racing.importId, {}), raceBody = { groups: raceRows.groups.map(group => decision(group)) };
    const resolver = service.fetchClients;
    service.fetchClients = async (...args) => {
      const response = await resolver(...args);
      await history.editWork(ctx, raceBody.groups[0]!.rows[0]!.id, { notes: 'Correction made while Clients resolves', revision: 1 });
      return response;
    };
    await assert.rejects(service.review(ctx, racing.importId, raceBody, authorization), /work_log_revision_conflict/);
    service.fetchClients = resolver;
    const postRace = await service.students(ctx, racing.importId, {});
    assert.ok(postRace.groups.every(group => group.rows.every(row => row.identity.status === 'unreviewed')), 'The stale group must roll back all row associations');
    const creationsAfterRace = creations;
    assert.equal((await service.review(ctx, racing.importId, { groups: postRace.groups.map(group => decision(group)) }, authorization)).linked, 2);
    assert.equal(creations, creationsAfterRace, 'Retry after a concurrent revision recovers Clients mappings');
  } finally {
    await db.withTenant(ctx.businessId, async tx => {
      await tx.query('DELETE FROM billing_work_import_student_reviews'); await tx.query('DELETE FROM billing_work_identities');
      await tx.query('DELETE FROM billing_work_log'); await tx.query('DELETE FROM billing_history_sources'); await tx.query('DELETE FROM billing_student_aliases');
      await tx.query('DELETE FROM billing_idempotency');
      await tx.query("DELETE FROM service_outbox WHERE event->>'businessId'=$1", [ctx.businessId]);
    });
    await db.pool.end();
  }
});
