import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { getSchema } from 'better-auth/db';
import { businessSchema, settingsSchema, starterEntitlements } from '../src/schemas.js';
import { IdentityService } from '../src/identity.service.js';
import { AuthController } from '../src/auth.controller.js';
import { BusinessesController, ContextController } from '../src/businesses.controller.js';
import type { Database } from '@palladium/service-kit';

const tenant = '11111111-1111-4111-8111-111111111111';
test('production businesses start with zero paid entitlements', () => {
  assert.deepEqual(starterEntitlements('production'), []);
  assert.ok(starterEntitlements('development').includes('clients'));
});
test('business/settings validation rejects entitlement grants, invalid timezone and unsafe branding URL', () => {
  assert.equal(businessSchema.safeParse({ name: 'Example', entitlements: ['payments'] }).success, false);
  assert.equal(businessSchema.safeParse({ name: 'Example', timezone: 'Not/AZone' }).success, false);
  assert.equal(settingsSchema.safeParse({ entitlements: ['clients'] }).success, false);
  assert.equal(settingsSchema.safeParse({ branding: { displayName: 'Example', primaryColor: '#123456', logoUrl: 'javascript:alert(1)' } }).success, false);
  assert.equal(settingsSchema.safeParse({}).success, false);
});
test('internal secret is timing-safe checked and absent/incorrect secret is rejected', () => {
  const value = Object.create(IdentityService.prototype) as IdentityService;
  Object.assign(value, { internalSecret: 'a'.repeat(32), trustedOrigins: ['http://localhost:3000'] });
  assert.throws(() => value.assertInternalSecret({ headers: {} } as Request));
  assert.throws(() => value.assertInternalSecret({ headers: { 'x-platform-internal-secret': 'b'.repeat(32) } } as Request));
  assert.doesNotThrow(() => value.assertInternalSecret({ headers: { 'x-platform-internal-secret': 'a'.repeat(32) } } as Request));
  assert.throws(() => value.assertMutationOrigin({ headers: { origin: 'https://attacker.invalid' } } as Request));
  assert.throws(() => value.assertMutationOrigin({ headers: {} } as Request));
  assert.doesNotThrow(() => value.assertMutationOrigin({ headers: { origin: 'http://localhost:3000' } } as Request));
});
test('auth passthrough restores gateway auth path and preserves multiple cookies and parsed body', async () => {
  let upstream: globalThis.Request | undefined;
  const identity = { gatewayUrl: 'http://localhost:8080', auth: { handler: async (request: globalThis.Request) => {
    upstream = request;
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'session=one; Path=/; HttpOnly');
    headers.append('set-cookie', 'cache=two; Path=/; HttpOnly');
    return new globalThis.Response('{"user":{"id":"one"}}', { status: 200, headers });
  } } } as unknown as IdentityService;
  const responseHeaders: Record<string, unknown> = {};
  const res = { status(code: number) { assert.equal(code, 200); return this; }, setHeader(name: string, value: unknown) { responseHeaders[name] = value; }, send(body: Buffer) { assert.equal(JSON.parse(body.toString()).user.id, 'one'); } } as unknown as Response;
  await new AuthController(identity).handle({ originalUrl: '/auth/sign-in/email?callbackURL=%2F', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '999', origin: 'http://localhost:3000' }, body: { email: 'test@example.invalid', password: 'long-password' } } as Request, res);
  assert.equal(upstream!.url, 'http://localhost:8080/api/platform/auth/sign-in/email?callbackURL=%2F');
  assert.equal((await upstream!.json()).email, 'test@example.invalid');
  assert.equal(upstream!.headers.has('content-length'), false);
  assert.equal((responseHeaders['set-cookie'] as string[]).length, 2);
});
test('internal context rejects absent membership inside selected tenant', async () => {
  let selected = '';
  const db = { async withTenant(id: string, work: (tx: unknown) => Promise<unknown>) { selected = id; return work({ query: async () => ({ rows: [] }) }); } } as unknown as Database;
  const identity = Object.assign(Object.create(IdentityService.prototype), {
    database: db, assertInternalSecret() {},
    requireSession: async () => ({ user: { id: 'user-a' } }),
  }) as IdentityService;
  await assert.rejects(new ContextController(db, identity).context({} as Request, { businessId: tenant }), /Business membership is required/);
  assert.equal(selected, tenant);
});
test('owner-only settings reject tutor membership without writing', async () => {
  let writes = 0;
  const db = { async withTenant(_id: string, work: (tx: unknown) => Promise<unknown>) { return work({ query: async (sql: string) => { if (sql.startsWith('UPDATE')) writes++; return { rows: [{ role: 'tutor' }] }; } }); } } as unknown as Database;
  const identity = { assertMutationOrigin() {}, requireSession: async () => ({ user: { id: 'tutor-a' } }) } as unknown as IdentityService;
  await assert.rejects(new BusinessesController(db, identity).settings({} as Request, tenant, { language: 'fr' }), /Owner or admin/);
  assert.equal(writes, 0);
});

// This checks the installed library's real core field names against the explicit
// SQL migration. End-to-end auth checks still require PostgreSQL.
test('explicit identity migration contains the installed Better Auth core schema', async () => {
  const sql = await readFile(new URL('../migrations/001_identity.sql', import.meta.url), 'utf8');
  const schema = getSchema({ emailAndPassword: { enabled: true } });
  for (const [name, table] of Object.entries(schema)) {
    const start = sql.indexOf(`CREATE TABLE "${name}"`);
    assert.ok(start >= 0, `Missing Better Auth table ${name}`);
    const tableSql = sql.slice(start, sql.indexOf('\n);', start));
    for (const field of Object.keys(table.fields)) {
      assert.ok(tableSql.includes(`"${field}"`), `Missing ${name}.${field}`);
    }
  }
});
