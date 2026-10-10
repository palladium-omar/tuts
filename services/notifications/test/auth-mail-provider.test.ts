import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResendAuthMailProvider, AuthMailDeliveryError } from '../src/auth-mail-providers.js';

const mail = {recipientEmail:'synthetic@example.test', token:'synthetic-token', resetUrl:'https://example.test/reset'};
test('default transport preserves the global fetch receiver and needs no AbortSignal.any', async () => {
  const originalFetch = globalThis.fetch;
  const originalAny = AbortSignal.any;
  let calls = 0;
  globalThis.fetch = function(this: unknown, _input, init) {
    assert.equal(this, globalThis);
    assert.ok(init?.signal instanceof AbortSignal);
    calls++;
    return Promise.resolve(Response.json({id:'synthetic_id'}));
  } as typeof fetch;
  Object.defineProperty(AbortSignal, 'any', {value:undefined, configurable:true, writable:true});
  try {
    assert.equal(await new ResendAuthMailProvider('sender@example.test','synthetic-key').sendPasswordReset(mail), 'synthetic_id');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, 'any', {value:originalAny, configurable:true, writable:true});
  }
});
test('final retry preserves provider status without provider response contents', async () => {
  let calls = 0;
  const provider = new ResendAuthMailProvider('sender@example.test','synthetic-key', async () => {
    calls++;
    return new Response('private provider content', {status:429});
  });
  await assert.rejects(provider.sendPasswordReset(mail), error => {
    assert.ok(error instanceof AuthMailDeliveryError);
    assert.equal(error.category, 'provider_rejected');
    assert.equal(error.providerStatus,429);
    assert.ok(!JSON.stringify(error).includes('private provider content'));
    return true;
  });
  assert.equal(calls,2);
});
test('runtime transport failures retain a safe category', async () => {
  const provider = new ResendAuthMailProvider('sender@example.test','synthetic-key', async () => {throw new TypeError('secret details');});
  await assert.rejects(provider.sendPasswordReset(mail), error => {
    assert.ok(error instanceof AuthMailDeliveryError);
    assert.equal(error.category,'runtime_type_error');
    assert.ok(!error.message.includes('secret details'));
    return true;
  });
});
