import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { appOptions } from '../src/app.js';
import { HistoryService } from '../src/history.js';
import { StudentWorkHistoryService } from '../src/student-work-history.js';
import { StudentWorkHistoryController } from '../src/student-work-history.controller.js';

const ctx: RequestContext = { businessId: randomUUID(), sub: 'synthetic-staff', role: 'owner', entitlements: ['billing', 'clients'], requestId: randomUUID() };
const student = randomUUID(), alias = randomUUID(), authorization = 'Bearer synthetic-signed-context';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('student work contract denies learner roles, missing permissions, entitlements and ungranted IDs before reads', async () => {
  assert.ok(appOptions.controllers.includes(StudentWorkHistoryController)); assert.ok(appOptions.providers.includes(StudentWorkHistoryService));
  assert.deepEqual(Reflect.getMetadata('palladium.roles', StudentWorkHistoryController), ['owner', 'admin', 'tutor']);
  assert.equal(Reflect.getMetadata('palladium.student-scoped', StudentWorkHistoryController), true);
  let requests = 0, reads = 0;
  const service = new StudentWorkHistoryService({ withTenant: async () => { reads++; throw new Error('must not read'); } } as unknown as Database);
  service.fetchStudent = async () => { requests++; return json({ item: { id: student, kind: 'student' } }); };
  for (const denied of [
    { ...ctx, role: 'student' }, { ...ctx, role: 'parent' },
    { ...ctx, permissions: ['billing.read', 'clients.read'] },
    { ...ctx, permissions: ['reporting.financial', 'clients.read'] },
    { ...ctx, permissions: ['reporting.financial', 'billing.read'] },
    { ...ctx, entitlements: ['billing'] }, { ...ctx, entitlements: ['clients'] },
    { ...ctx, role: 'tutor', accessScope: 'students', studentIds: [] },
  ]) await assert.rejects(service.history(denied as RequestContext, student, {}, authorization));
  for (const query of [{ limit: 101 }, { offset: -1 }, { month: '2026-13' }, { unexpected: true }]) await assert.rejects(service.history(ctx, student, query, authorization));
  await assert.rejects(service.history(ctx, 'not-a-student', {}, authorization));
  await assert.rejects(service.history(ctx, student, {}, undefined));
  assert.equal(requests, 0); assert.equal(reads, 0);
  await assert.rejects(service.history({ ...ctx, role: 'tutor', accessScope: 'students', studentIds: [alias] }, alias, {}, authorization), /Student access is not granted/);
  assert.equal(requests, 1); assert.equal(reads, 0);
});

test('canonical student verification forwards authorization and bounds unavailable, malformed and oversized sources', async () => {
  let reads = 0;
  const service = new StudentWorkHistoryService({ withTenant: async () => { reads++; throw new Error('must not read'); } } as unknown as Database);
  for (const response of [json({}, 401), json({}, 403), json({}, 404), json({}, 503), json({ item: { id: student, kind: 'payer' } }), new Response('invalid JSON'), new Response('x'.repeat(65537))]) {
    service.fetchStudent = async (destination, path, options) => {
      assert.equal(destination, 'clients'); assert.equal(path, `/v1/clients/${student}/identity`);
      assert.equal(new Headers(options?.headers).get('authorization'), authorization);
      assert.ok(options?.signal instanceof AbortSignal); return response;
    };
    await assert.rejects(service.history(ctx, student, {}, authorization));
  }
  service.fetchStudent = async () => { throw new Error('private-source-name-and-credential'); };
  await assert.rejects(service.history(ctx, student, {}, authorization), error => error instanceof Error && error.message === 'Student verification unavailable');
  assert.equal(reads, 0);
});

test('student verification deadline also bounds a stalled body', async () => {
  const service = new StudentWorkHistoryService({ withTenant: async () => { throw new Error('must not read'); } } as unknown as Database);
  let cancelled = false;
  service.fetchStudent = async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
  const started = Date.now();
  await assert.rejects(service.history(ctx, student, {}, authorization), /Student verification/);
  assert.ok(Date.now() - started < 6500); assert.equal(cancelled, true);
});

test('real tenant Database work history keeps currencies separate, follows aliases, excludes stale rows and limits fields', { skip: !process.env.BILLING_TEST_DATABASE_URL }, async () => {
  const db = new Database(), original = db.pool, pool = new Pool({ connectionString: process.env.BILLING_TEST_DATABASE_URL, max: 2 });
  Object.defineProperty(db, 'pool', { value: pool });
  const business = randomUUID(), canonical = randomUUID(), old = randomUUID(), unrelated = randomUUID();
  const fixture = { ...ctx, businessId: business }, history = new HistoryService(db), service = new StudentWorkHistoryService(db);
  service.fetchStudent = async (_destination, path) => {
    assert.ok([canonical, old].some(id => path.endsWith(`${id}/identity`)));
    return json({ item: { id: canonical, kind: 'student', email: 'private@example.test', displayName: 'Never returned' } });
  };
  try {
    const role = (await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    const preview = await history.preview(fixture, { originalname: 'synthetic-private-source.csv', buffer: Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Currency,Invoice Status,Private Column\n2026-09-01,Synthetic A,1,10,EUR,Paid,private\n2026-09-02,Synthetic A,2,10,EUR,Pending,private\n2026-08-01,Synthetic A,3,10,EUR,Unsent,private\n2026-09-03,Synthetic A,4,10,EUR,Paid,private\n2026-09-04,Synthetic A,5,10,EUR,Paid,private\n2026-09-05,Synthetic B,6,10,USD,Paid,private\n2026-09-06,Synthetic A,0.5,12,USD,Pending,private') }, { kind: 'work' });
    assert.equal(preview.summary.valid, 7); await history.commit(fixture, { token: preview.token }, 'fixture-commit');
    await db.withTenant(business, async tx => {
      await tx.query('INSERT INTO billing_student_aliases(business_id,source_id,target_id) VALUES($1,$2,$3)', [business, old, canonical]);
      const work = (await tx.query('SELECT id,work_date::text date FROM billing_work_log ORDER BY work_date')).rows;
      for (const row of work) {
        if (row.date === '2026-09-04') continue;
        const identity = row.date === '2026-09-05' ? unrelated : row.date === '2026-09-01' ? old : canonical;
        await tx.query("INSERT INTO billing_work_identities(business_id,work_id,student_id,status,work_revision,reviewed_by) VALUES($1,$2,$3,'linked',1,'synthetic')", [business, row.id, identity]);
        if (row.date === '2026-09-03') await tx.query('UPDATE billing_work_log SET revision=2 WHERE id=$1', [row.id]);
      }
    });
    const scoped = { ...fixture, role: 'tutor' as const, accessScope: 'students' as const, studentIds: [old, canonical] };
    const result = (await service.history(scoped, old, { month: '2026-09', limit: 1 }, authorization)).item;
    assert.equal(result.studentId, canonical); assert.equal(result.month, '2026-09'); assert.equal(result.provenance, 'historical_work_declarations');
    assert.equal(result.total, 3); assert.equal(result.rows.length, 1); assert.equal(result.rows[0]!.date, '2026-09-06');
    assert.deepEqual(result.currencies, [
      { currency: 'EUR', totalHours: 6, totalMinor: 6000, paidMinor: 1000, pendingMinor: 2000, unsentMinor: 3000, monthHours: 3, monthMinor: 3000 },
      { currency: 'USD', totalHours: 0.5, totalMinor: 600, paidMinor: 0, pendingMinor: 600, unsentMinor: 0, monthHours: 0.5, monthMinor: 600 },
    ]);
    const page = (await service.history(fixture, canonical, { month: '2026-09', limit: 1, offset: 1 }, authorization)).item;
    assert.equal(page.total, 3); assert.equal(page.rows[0]!.date, '2026-09-02');
    const all = (await service.history(fixture, canonical, {}, authorization)).item;
    assert.equal(all.total, 4); assert.equal(all.month, null); assert.equal(all.currencies[0]!.monthHours, null); assert.equal(all.currencies[0]!.monthMinor, null);
    assert.deepEqual(Object.keys(all.rows[0]!).sort(), ['id', 'date', 'serviceType', 'hours', 'amountMinor', 'currency', 'status', 'countAsClasses'].sort());
    for (const forbidden of ['private@example.test', 'Never returned', 'private-source', 'rawColumns', 'studentName', 'importId', 'file_bytes']) assert.equal(JSON.stringify(all).includes(forbidden), false);
    const emptyMonth = (await service.history(fixture, canonical, { month: '2026-10' }, authorization)).item;
    assert.equal(emptyMonth.total, 0); assert.deepEqual(emptyMonth.rows, []); assert.equal(emptyMonth.currencies[0]!.monthMinor, 0);
    const isolated = (await service.history({ ...fixture, businessId: randomUUID() }, canonical, {}, authorization)).item;
    assert.equal(isolated.total, 0); assert.deepEqual(isolated.currencies, []);
    await assert.rejects(service.history({ ...scoped, studentIds: [old] }, old, {}, authorization), /Student access is not granted/);
    await db.withTenant(business, tx => tx.query('UPDATE billing_work_log SET amount_minor=$1', [Number.MAX_SAFE_INTEGER]));
    await assert.rejects(service.history(fixture, canonical, {}, authorization), /supported exact monetary range/);
  } finally {
    await db.withTenant(business, async tx => {
      await tx.query('DELETE FROM billing_work_identities'); await tx.query('DELETE FROM billing_work_log');
      await tx.query('DELETE FROM billing_history_sources'); await tx.query('DELETE FROM billing_student_aliases');
      await tx.query('DELETE FROM billing_idempotency'); await tx.query("DELETE FROM service_outbox WHERE event->>'businessId'=$1", [business]);
    });
    await pool.end(); await original.end();
  }
});
