import assert from 'node:assert/strict';
import test from 'node:test';
import { createServiceApplication } from '../src/index.js';
import { boundedRequest, readBoundedResponse, shouldPublishMutation, MAX_BRIDGE_REQUEST_BYTES } from '../src/http-limits.js';
import { expensiveRequestClass, ExpensiveRequestGuard } from '../src/quotas.js';
import { EventBus } from '../src/events.js';
import { Database } from '../src/database.js';
import type { ExecutionContext } from '@nestjs/common';

test('OpenAPI is registered before the Nest fallback and errors carry private headers', async () => {
  const app = await createServiceApplication({ name: 'smoke', port: 0, controllers: [], migrationsDir: '' }, false);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const spec = await fetch(`${base}/openapi.json`);
    assert.equal(spec.status, 200);
    assert.ok((await spec.json()).paths['/health']);
    assert.equal(spec.headers.get('cache-control'), 'private, no-store');
    assert.match(spec.headers.get('vary')!, /Authorization/);
    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'private, no-store');
  } finally { await app.close(); }
});
test('reads and unsuccessful mutations never trigger HTTP outbox publication', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(shouldPublishMutation(method, 200), false);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.equal(shouldPublishMutation(method, 201), true);
    assert.equal(shouldPublishMutation(method, 500), false);
  }
});
test('transport rejects oversized declared requests and incrementally bounded responses', async () => {
  assert.throws(() => boundedRequest(new Request('https://internal/upload', { method: 'POST', body: 'small', headers: { 'content-length': String(MAX_BRIDGE_REQUEST_BYTES + 1) } })), /exceeds/);
  assert.deepEqual(await readBoundedResponse(new Response('abc'), 3), new TextEncoder().encode('abc'));
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedResponse(new Response(body), 3), /exceeds/);
  assert.equal(cancelled, true);
});
test('expensive budgets use verified tenant and actor scopes and fail closed on exhaustion', async () => {
  assert.equal(expensiveRequestClass('reporting', 'POST', '/v1/summaries'), 'reporting');
  assert.equal(expensiveRequestClass('billing', 'POST', '/v1/history/imports'), 'mutation');
  assert.equal(expensiveRequestClass('clients', 'GET', '/v1/imports'), undefined);
  const scopes: string[] = [];
  let exhausted = false;
  const db = { async transaction(work: any) { return work({ async query(sql: string, values: any[]) { assert.match(sql, /ON CONFLICT/); scopes.push(values[0]); return { rowCount: exhausted ? 0 : 1 }; } }); } } as Database;
  const guard = new ExpensiveRequestGuard(db, { name: 'billing', port: 0, controllers: [], migrationsDir: '' });
  let retry: string | undefined;
  const request = { method: 'POST', path: '/v1/history/imports', context: { businessId: 'verified-business', sub: 'verified-actor' } };
  const execution = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader(_k: string, v: string) { retry = v; } }) }) } as ExecutionContext;
  await guard.canActivate(execution);
  assert.deepEqual(scopes.sort(), ['mutation:actor:verified-business:verified-actor', 'mutation:tenant:verified-business']);
  exhausted = true;
  await assert.rejects(guard.canActivate(execution), (e: any) => e.getStatus() === 429);
  assert.equal(retry, '60');
});
test('retention deletes only old published payloads and never inbox replay tombstones', async () => {
  const queries: string[] = [];
  const db = { async transaction(work: any) { return work({ async query(sql: string) { queries.push(sql); } }); } } as Database;
  await new EventBus(db, { name: 'billing', port: 0, controllers: [], migrationsDir: '' }).prunePublishedOutbox();
  assert.match(queries[0]!, /published_at < now\(\) - interval '30 days'/);
  assert.match(queries[0]!, /SKIP LOCKED LIMIT 1000/);
  assert.ok(queries.every(sql => !sql.includes('service_inbox')));
});

test('read-only Reporting summary POST skips outbox while genuine reporting mutations still publish',()=>{
  for(const path of ['/v1/summaries','/v1/summaries/','/v1/summaries?includeFinancial=true'])assert.equal(shouldPublishMutation('POST',201,'reporting',path),false);
  assert.equal(shouldPublishMutation('POST',201,'reporting','/v1/students/id/reconcile'),true);
  assert.equal(shouldPublishMutation('POST',201,'reporting','/v1/summaries/other'),true);
  assert.equal(shouldPublishMutation('POST',201,'billing','/v1/summaries'),true);
  assert.equal(shouldPublishMutation('PATCH',200,'reporting','/v1/summaries'),true);
});
