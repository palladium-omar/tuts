import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Database } from '@palladium/service-kit';
import { IdentityService } from '../src/identity.service.js';

const enabled = !!process.env.PLATFORM_TEST_DATABASE_URL && !!process.env.BETTER_AUTH_SECRET && !!process.env.PLATFORM_INTERNAL_SECRET;
test('real Better Auth persists hashed credentials, validates login and revokes session at signout', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: process.env.PLATFORM_TEST_DATABASE_URL });
  const identity = new IdentityService({ pool } as Database);
  const email = `synthetic-${randomUUID()}@example.invalid`;
  const password = `Synthetic-${randomUUID()}`;
  const send = (path: string, body: object, cookie?: string) => identity.auth.handler(new Request(`${identity.gatewayUrl}/api/platform/auth/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: identity.trustedOrigins[0]!, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  try {
    const registration = await send('sign-up/email', { name: 'Synthetic authentication fixture', email, password });
    assert.equal(registration.status, 200);
    const registered = await registration.json() as { user: { id: string } };
    assert.ok(registered.user.id);
    const credentials = await pool.query('SELECT password FROM account WHERE "userId"=$1 AND "providerId"=$2', [registered.user.id, 'credential']);
    assert.ok(credentials.rows[0].password.length > 32);
    assert.notEqual(credentials.rows[0].password, password);
    const wrongPassword = await send('sign-in/email', { email, password: `${password}-wrong` });
    assert.equal(wrongPassword.status, 401);
    const login = await send('sign-in/email', { email, password });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie();
    assert.ok(cookies.some(cookie => /Path=\//i.test(cookie)));
    assert.ok(cookies.some(cookie => /HttpOnly/i.test(cookie)));
    const cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const verified = await identity.auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.equal(verified?.user.id, registered.user.id);
    const signout = await send('sign-out', {}, cookie);
    assert.equal(signout.status, 200);
    assert.equal(await identity.auth.api.getSession({ headers: new Headers({ cookie }) }), null);
  } finally {
    await pool.query('DELETE FROM "user" WHERE email=$1', [email]);
    await pool.end();
  }
});
