import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestContext } from '@palladium/contracts';
import { serviceFetch } from '@palladium/service-kit';
import { appOptions } from '../src/app.js';
import { BusinessDashboardController, BusinessDashboardService, composeBusinessDashboard } from '../src/business-dashboard.js';

const context: RequestContext = {
  sub: '00000000-0000-4000-8000-000000000001', businessId: '00000000-0000-4000-8000-000000000002',
  role: 'owner', accessScope: 'business', entitlements: ['reporting', 'clients', 'billing'], requestId: 'dashboard-test',
};
const authorization = 'Bearer synthetic-signed-context';
type FetchSource = typeof serviceFetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function currency(code: string) {
  return { currency: code, totalRecordedRevenueMinor: 3000, historicalPaidMinor: 2000, verifiedCollectedMinor: 1000, pendingMinor: 500, unsentMinor: 100, expectedThisMonthMinor: null, ledgerMonthMinor: null, nativeExpectedMinor: 700 };
}
function analytics() {
  return {
    month: '2026-10', timeZone: 'Africa/Casablanca', asOf: '2026-10-10T12:00:00.000Z',
    students: { tracked: 4, activeThisMonth: 2, activePreviousMonth: 3, lostFromPreviousMonth: 1 },
    engagement: { totalHours: 12, monthHours: 4, averageCommitmentHours: 2, averageClassFrequency: null, churnRate: 1 / 3 },
    currencies: [currency('EUR'), currency('USD')],
    trend: [{ month: '2026-09', hours: 8, activeStudents: 3, classes: null }, { month: '2026-10', hours: 4, activeStudents: 2, classes: 2 }],
    coverage: { workRows: 4, importedInvoices: 1, nativeInvoices: 2, confirmedClasses: 2, sourceFiles: 1, studentIdentity: 'unlinked_source_names_and_native_student_ids', payments: 'verified_allocations_excluding_simulated', churn: 'inactivity', provisional: true, notes: ['Current month inactivity is provisional.'] },
  };
}
function successful(service: string, _path: string): Response {
  if (service === 'billing') return json({ item: analytics() });
  return json({ item: { total: 4, active: 2, leads: 1, inactive: 1, privateContactName: 'Never expose names' } });
}

test('business controller is registered, staff only, and never opts into student scope', () => {
  assert.ok(appOptions.controllers.includes(BusinessDashboardController));
  assert.ok(appOptions.providers.includes(BusinessDashboardService));
  assert.deepEqual(Reflect.getMetadata('palladium.roles', BusinessDashboardController), ['owner', 'admin', 'tutor']);
  assert.deepEqual(Reflect.getMetadata('palladium.permissions', BusinessDashboardController.prototype.dashboard), ['reporting.read']);
  assert.equal(Reflect.getMetadata('palladium.student-scoped', BusinessDashboardController), undefined);
});

test('permission, scope, entitlement, authorization and malformed month failures make no source requests', async () => {
  let calls = 0;
  const fetchSource: FetchSource = async () => { calls++; return json({}); };
  for (const changes of [{ role: 'student' }, { role: 'parent' }, { accessScope: 'students' }, { permissions: [] }, { entitlements: ['clients', 'billing'] }]) {
    await assert.rejects(composeBusinessDashboard({ ...context, ...changes } as RequestContext, {}, authorization, fetchSource));
  }
  for (const month of ['2026-00', '2026-13', '2026-1', '1999-12', '2201-01']) {
    await assert.rejects(composeBusinessDashboard(context, { month }, authorization, fetchSource));
  }
  await assert.rejects(composeBusinessDashboard(context, { unexpected: true }, authorization, fetchSource));
  await assert.rejects(composeBusinessDashboard(context, {}, '', fetchSource));
  assert.equal(calls, 0);
});

test('one student stats request and one financial aggregate run concurrently within the fixed budget', async () => {
  const requests: { service: string; path: string; init?: RequestInit }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchSource: FetchSource = async (service, path, init) => {
    requests.push({ service, path, init });
    if (requests.length === 2) release();
    await gate;
    return successful(service, path);
  };
  const result = await composeBusinessDashboard(context, { month: '2026-10' }, authorization, fetchSource);
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(request => request.service === 'billing').length, 1);
  for (const request of requests) {
    assert.equal(new Headers(request.init?.headers).get('authorization'), authorization);
    assert.ok(request.init?.signal instanceof AbortSignal);
    if (request.service === 'clients') {
      assert.equal(request.path, '/v1/clients/student-stats');
    }
  }
  assert.deepEqual(result.item.students, { total: 4, active: 2, leads: 1, inactive: 1 });
  assert.equal(result.item.sources.every(source => source.status === 'complete'), true);
  assert.equal(JSON.stringify(result).includes('Never expose names'), false);
});

test('default month and time zone come from business-local Billing analytics without an extra settings read', async () => {
  const requests: string[] = [];
  const fetchSource: FetchSource = async (service, path) => { requests.push(path); return successful(service, path); };
  const result = await composeBusinessDashboard(context, {}, authorization, fetchSource);
  assert.equal(result.item.month, '2026-10'); assert.equal(result.item.timeZone, 'Africa/Casablanca');
  assert.ok(requests.includes('/v1/business-analytics'));
  assert.equal(requests.length, 2);
});

test('financial permission or Billing entitlement absence prevents every financial request', async () => {
  for (const restricted of [
    { ...context, permissions: ['reporting.read', 'clients.read', 'billing.read'] },
    { ...context, permissions: ['reporting.read', 'clients.read', 'reporting.financial'] },
    { ...context, entitlements: ['reporting', 'clients'] },
  ]) {
    const requests: string[] = [];
    const fetchSource: FetchSource = async (service, path) => { requests.push(service); return successful(service, path); };
    const result = await composeBusinessDashboard(restricted, { month: '2026-10' }, authorization, fetchSource);
    assert.deepEqual(requests, ['clients']);
    assert.equal(result.item.analytics, null); assert.equal(result.item.timeZone, null);
    assert.equal(result.item.sources.at(-1)?.status, 'unavailable');
  }
});

test('Clients restriction suppresses count requests independently of authorized finance', async () => {
  const requests: string[] = [];
  const fetchSource: FetchSource = async (service, path) => { requests.push(service); return successful(service, path); };
  const result = await composeBusinessDashboard({ ...context, permissions: ['reporting.read', 'billing.read', 'reporting.financial'] }, {}, authorization, fetchSource);
  assert.deepEqual(requests, ['billing']);
  assert.deepEqual(result.item.students, { total: null, active: null, leads: null, inactive: null });
  assert.ok(result.item.analytics);
});

test('student stats failures preserve finance, produce null counts, and never expose upstream details', async () => {
  for (const failure of [async () => json({ password: 'secret-api-token' }, 503), async (): Promise<Response> => { throw new Error('secret-api-token'); }]) {
    const fetchSource: FetchSource = async (service, path) => service === 'clients' ? failure() : successful(service, path);
    const result = await composeBusinessDashboard(context, {}, authorization, fetchSource);
    assert.deepEqual(result.item.students, { total: null, active: null, leads: null, inactive: null });
    assert.ok(result.item.analytics);
    assert.equal(result.item.sources.filter(source => source.status === 'unavailable').length, 1);
    assert.equal(result.item.sources[0]?.name, 'clients');
    assert.equal(JSON.stringify(result).includes('secret-api-token'), false);
  }
});

test('currency measures are independently preserved and unknown Billing fields are discarded', async () => {
  const value = analytics();
  const fetchSource: FetchSource = async (service, path) => service === 'billing'
    ? json({ item: { ...value, rawInvoices: ['secret-api-token'] }, error: { message: 'secret-api-token' } })
    : successful(service, path);
  const result = await composeBusinessDashboard(context, {}, authorization, fetchSource);
  assert.deepEqual(result.item.analytics?.currencies, value.currencies);
  assert.equal(result.item.analytics?.currencies[0]?.expectedThisMonthMinor, null);
  assert.equal(JSON.stringify(result).includes('secret-api-token'), false);
});

test('invalid numeric aggregates, currencies, duplicate currency buckets and month mismatch fail Billing independently', async () => {
  const invalid = [
    { ...analytics(), currencies: [{ ...currency('EUR'), pendingMinor: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...analytics(), currencies: [{ ...currency('EUR'), currency: 'eur' }] },
    { ...analytics(), currencies: [currency('EUR'), currency('EUR')] },
    { ...analytics(), engagement: { ...analytics().engagement, churnRate: 10 } },
    { ...analytics(), month: '2026-09' },
  ];
  for (const value of invalid) {
    const fetchSource: FetchSource = async (service, path) => service === 'billing' ? json({ item: value }) : successful(service, path);
    const result = await composeBusinessDashboard(context, { month: '2026-10' }, authorization, fetchSource);
    assert.equal(result.item.analytics, null); assert.equal(result.item.timeZone, null);
    assert.equal(result.item.students.total, 4); assert.equal(result.item.sources.at(-1)?.status, 'unavailable');
  }
});

test('malformed, oversized, incomplete or inconsistent student stats are explicit source gaps', async () => {
  for (const response of [json({ item: { total: 4 } }), json({ item: { total: 4, active: -1, leads: 4, inactive: 1 } }), json({ item: { total: 4, active: 1, leads: 1, inactive: 1 } }), json({ item: { total: Number.MAX_SAFE_INTEGER + 1, active: Number.MAX_SAFE_INTEGER + 1, leads: 0, inactive: 0 } }), new Response('invalid json'), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const fetchSource: FetchSource = async (service, path) => service === 'clients' ? response : successful(service, path);
    const result = await composeBusinessDashboard(context, {}, authorization, fetchSource);
    assert.deepEqual(result.item.students, { total: null, active: null, leads: null, inactive: null });
    assert.ok(result.item.analytics);
    assert.equal(result.item.sources.find(source => source.name === 'clients')?.status, 'unavailable');
  }
});

test('timeout bounds sources that ignore abort and sources with stalled response bodies', async () => {
  for (const stalled of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const fetchSource: FetchSource = async (service, path) => service === 'billing' ? stalled() : successful(service, path);
    const start = Date.now();
    const result = await composeBusinessDashboard(context, {}, authorization, fetchSource, 25);
    assert.ok(Date.now() - start < 1000);
    assert.equal(result.item.analytics, null); assert.equal(result.item.students.total, 4);
    assert.match(result.item.sources.at(-1)?.reason ?? '', /timed out/);
  }
});

test('production composition reaches private service bindings with the original signed authorization', async () => {
  const { withCloudflareInvocation } = await import(new URL('./runtime.js', import.meta.resolve('@palladium/service-kit')).href);
  const requests: Request[] = [];
  const binding = { fetch: async (request: Request) => {
    requests.push(request);
    const url = new URL(request.url);
    return successful(url.hostname.split('.')[0]!, `${url.pathname}${url.search}`);
  } };
  const result = await withCloudflareInvocation({ CLIENTS: binding, BILLING: binding }, () => composeBusinessDashboard(context, {}, authorization));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.headers.get('authorization') === authorization && new URL(request.url).hostname.endsWith('.internal')));
  assert.ok(result.item.analytics);
});
