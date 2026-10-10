import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { defaultPermissions, hasPermission, canReadFinancial } from '@palladium/contracts';
import { ContextGuard, Permissions, Roles, StudentScoped } from '../src/auth.js';

const tenant = '11111111-1111-4111-8111-111111111111';
test('learner presets and explicit overrides cannot grant billing or tutor analytics', () => {
  for (const role of ['student', 'parent']) {
    const forbidden = ['billing.read', 'billing.write', 'payments.read', 'payments.write', 'reporting.read', 'reporting.financial'];
    for (const permission of forbidden) {
      assert.equal(defaultPermissions(role).includes(permission as never), false);
      assert.equal(hasPermission({ role, permissions: forbidden }, permission), false);
    }
    assert.equal(canReadFinancial({ role, permissions: ['billing.read', 'reporting.financial'] }), false);
    assert.equal(hasPermission({ role }, 'planning.write'), true);
  }
  assert.equal(hasPermission({ role: 'student' }, 'reporting.write'), true);
  assert.equal(hasPermission({ role: 'parent' }, 'reporting.write'), false);
  assert.equal(canReadFinancial({ role: 'tutor' }), true);
  assert.equal(canReadFinancial({ role: 'tutor', permissions: ['reporting.read'] }), false);
});

test('signed learner contexts are blocked on staff reports, while scoped activity still works', async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const previous = process.env.CONTEXT_PUBLIC_KEY;
  process.env.CONTEXT_PUBLIC_KEY = await exportSPKI(publicKey);
  class Reports { read() {} activity() {} }
  StudentScoped()(Reports);
  Roles('owner', 'admin', 'tutor')(Reports.prototype, 'read', Object.getOwnPropertyDescriptor(Reports.prototype, 'read')!);
  Permissions('reporting.read')(Reports.prototype, 'read', Object.getOwnPropertyDescriptor(Reports.prototype, 'read')!);
  Roles('student')(Reports.prototype, 'activity', Object.getOwnPropertyDescriptor(Reports.prototype, 'activity')!);
  Permissions('reporting.write')(Reports.prototype, 'activity', Object.getOwnPropertyDescriptor(Reports.prototype, 'activity')!);
  try {
    const guard = new ContextGuard(new Reflector(), { name: 'reporting', port: 0, controllers: [], migrationsDir: '.', entitlement: 'reporting' });
    async function execute(role: string, method: 'read' | 'activity', permissions?: string[]) {
      const token = await new SignJWT({ sub: 'synthetic-user', businessId: tenant, role, entitlements: ['reporting'], requestId: 'synthetic-check', permissions, accessScope: 'students', studentIds: [] }).setProtectedHeader({ alg: 'EdDSA' }).setIssuedAt().setIssuer('palladium-gateway').setAudience('palladium-services').setExpirationTime('60s').sign(privateKey);
      const req = { headers: { authorization: `Bearer ${token}` }, method: 'POST' };
      return guard.canActivate({ getHandler: () => Reports.prototype[method], getClass: () => Reports, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
    }
    await assert.rejects(execute('student', 'read', ['reporting.read']), /Role cannot/);
    await assert.rejects(execute('parent', 'read', ['reporting.read']), /Role cannot/);
    assert.equal(await execute('student', 'activity'), true);
    assert.equal(await execute('tutor', 'read'), true);
    await assert.rejects(execute('tutor', 'read', []), /not permitted/);
  } finally { if (previous === undefined) delete process.env.CONTEXT_PUBLIC_KEY; else process.env.CONTEXT_PUBLIC_KEY = previous; }
});
