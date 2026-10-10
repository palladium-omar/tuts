import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { Database } from '../src/database.js';
import { currentCloudflareBindings, isCloudflareRuntime, serviceFetch, withCloudflareInvocation } from '../src/runtime.js';

test('concurrent invocation bindings and retained pool methods stay in their own scope', async () => {
  const oldRuntime = process.env.TUTS_RUNTIME;
  process.env.TUTS_RUNTIME = 'cloudflare';
  const db = new Database();
  const stablePool = db.pool;
  assert.ok(stablePool instanceof Pool);
  const results = await Promise.all(['first', 'second'].map(async name => {
    return withCloudflareInvocation({ DATABASE_URL: `postgres://user:password@${name}/db`, NAME: name }, async () => {
      assert.equal(isCloudflareRuntime(), true);
      const before = stablePool.options.connectionString;
      await new Promise(resolve => setTimeout(resolve, name === 'first' ? 10 : 1));
      assert.equal(stablePool.options.connectionString, before);
      assert.equal(currentCloudflareBindings()?.NAME, name);
      return before;
    });
  }));
  assert.deepEqual(results, ['postgres://user:password@first/db', 'postgres://user:password@second/db']);
  assert.equal(currentCloudflareBindings(), undefined);
  assert.throws(() => stablePool.connect, /active invocation/);
  await withCloudflareInvocation({ DATABASE_URL: 'postgres://third/db' }, async () => {
    assert.equal(stablePool.options.connectionString, 'postgres://third/db');
  });
  if (oldRuntime === undefined) delete process.env.TUTS_RUNTIME;
  else process.env.TUTS_RUNTIME = oldRuntime;
});

test('invocation pools close after errors as well as successful work', async () => {
  const oldEnd = Pool.prototype.end;
  const closed: string[] = [];
  Pool.prototype.end = async function () { closed.push(this.options.connectionString!); } as typeof oldEnd;
  try {
    await assert.rejects(withCloudflareInvocation({ DATABASE_URL: 'postgres://failure/db' }, async () => {
      const db = new Database();
      void db.pool.options;
      throw new Error('failed work');
    }), /failed work/);
    assert.deepEqual(closed, ['postgres://failure/db']);
  } finally { Pool.prototype.end = oldEnd; }
});

test('service fetch forwards timeout signal and private bindings without URL fallback', async () => {
  const abort = new AbortController();
  let seen: Request | undefined;
  await withCloudflareInvocation({ BILLING: { async fetch(request: Request) { seen = request; return new Response('bound'); } } }, async () => {
    const response = await serviceFetch('billing', '/v1/invoices?month=2026-10', {
      method: 'POST', body: '{}', signal: abort.signal, headers: { authorization: 'Bearer signed-context' },
    });
    assert.equal(await response.text(), 'bound');
    assert.equal(seen?.url, 'https://billing.internal/v1/invoices?month=2026-10');
    assert.equal(seen?.headers.get('authorization'), 'Bearer signed-context');
    abort.abort();
    assert.equal(seen?.signal.aborted, true);
    await assert.rejects(serviceFetch('clients', '/health'), /Missing CLIENTS service binding/);
    await assert.rejects(serviceFetch('billing', '//external.example/health'), /Invalid internal/);
  });
});

test('Node service destinations reject embedded credentials and unsupported schemes', async () => {
  const oldRuntime = process.env.TUTS_RUNTIME;
  const oldUrl = process.env.BILLING_URL;
  delete process.env.TUTS_RUNTIME;
  try {
    for (const base of ['https://user:secret@example.invalid', 'file:///tmp/private', 'ftp://example.invalid']) {
      process.env.BILLING_URL = base;
      await assert.rejects(serviceFetch('billing', '/health'), /Invalid internal service URL/);
    }
  } finally {
    if (oldRuntime === undefined) delete process.env.TUTS_RUNTIME;
    else process.env.TUTS_RUNTIME = oldRuntime;
    if (oldUrl === undefined) delete process.env.BILLING_URL;
    else process.env.BILLING_URL = oldUrl;
  }
});

test('registered mutation work retains invocation pools until background publication completes', async () => {
  const { registerBackgroundTask } = await import('../src/runtime.js');
  const oldEnd = Pool.prototype.end;
  const stages: string[] = [];
  let release!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; });
  const retained: Promise<unknown>[] = [];
  Pool.prototype.end = async function () { stages.push('pool closed'); } as typeof oldEnd;
  try {
    const response = await withCloudflareInvocation({ DATABASE_URL: 'postgres://background/db' }, async () => {
      const db = new Database();
      void db.pool.options;
      registerBackgroundTask((async () => { await block; assert.equal(db.pool.options.connectionString, 'postgres://background/db'); stages.push('published'); })());
      return 'response';
    }, { waitUntil(promise) { retained.push(promise); } });
    assert.equal(response, 'response');
    assert.deepEqual(stages, []);
    assert.equal(retained.length, 1);
    release();
    await Promise.all(retained);
    assert.deepEqual(stages, ['published', 'pool closed']);
  } finally { Pool.prototype.end = oldEnd; }
});
