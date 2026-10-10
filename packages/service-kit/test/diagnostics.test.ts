import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentDiagnosticId, diagnosticBusiness, diagnosticId, diagnosticRoute, logDiagnostic, safeDiagnosticError, withDiagnostics } from '../src/diagnostics.js';

test('diagnostics strip secrets, arbitrary route values and raw errors', () => {
  const secret = 'secret-password-reset-token';
  assert.equal(diagnosticRoute(`/api/platform/auth/reset-password?token=${secret}`), '/api/platform/auth/reset-password');
  assert.equal(diagnosticRoute('/api/clients/v1/clients/person@example.com'), '/api/clients/v1/clients/:param');
  const error = Object.assign(new Error(secret), { code: 'ECONNRESET', detail: secret, password: secret });
  error.stack = `Error: ${secret}\n at connect (/private/customer/worker.js:12:3)\n at ${secret} (https://evil.example/${secret}:2:3)`;
  assert.deepEqual(safeDiagnosticError(error), { kind: 'Error', code: 'ECONNRESET', locations: ['worker.js:12:3'] });
  assert.ok(!JSON.stringify(safeDiagnosticError({ name: secret, code: secret, stack: secret })).includes(secret));
});

test('parallel request scopes keep correlation and business context isolated', async () => {
  const a = diagnosticId(), b = diagnosticId();
  await Promise.all([a,b].map(id => withDiagnostics({service:'clients',requestId:id,trigger:'http'}, async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(currentDiagnosticId(), id);
  })));
  assert.equal(currentDiagnosticId(), undefined);
});

test('log output only includes explicitly safe fields', () => {
  const records: string[] = [];
  const previous = console.error;
  console.error = (value: string) => { records.push(value); };
  try {
    const id = diagnosticId();
    withDiagnostics({service:'clients',requestId:id,trigger:'http'}, () => {
      diagnosticBusiness('11111111-1111-4111-8111-111111111111');
      logDiagnostic('error','api_error', {status:500,route:'/v1/clients/private-name?password=hidden',error:new Error('hidden')});
    });
    assert.equal(records.length,1);
    assert.ok(!records[0]!.includes('hidden'));
    assert.ok(!records[0]!.includes('private-name'));
    const record = JSON.parse(records[0]!);
    assert.equal(record.businessId, '11111111-1111-4111-8111-111111111111');
    assert.equal(record.status,500);
  } finally { console.error = previous; }
});

test('auth mail diagnostics allow only known categories and HTTP status ranges', () => {
  const records: string[] = [];
  const previous = console.error;
  console.error = (value: string) => { records.push(value); };
  try {
    logDiagnostic('error','auth_mail_provider_failed', {providerStatus:429, failureCategory:'provider_rejected'});
    logDiagnostic('error','auth_mail_provider_failed', {providerStatus:999, failureCategory:'private-token@example.test'});
    assert.equal(JSON.parse(records[0]!).providerStatus,429);
    assert.equal(JSON.parse(records[0]!).failureCategory,'provider_rejected');
    assert.equal(JSON.parse(records[1]!).providerStatus,undefined);
    assert.equal(JSON.parse(records[1]!).failureCategory,undefined);
    assert.ok(!records.join('').includes('private-token'));
  } finally { console.error = previous; }
});
