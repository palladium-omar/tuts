import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import type { PlatformEvent } from '@palladium/contracts';
import { EventBus } from '../src/events.js';
import { Database } from '../src/database.js';
import { withCloudflareInvocation } from '../src/runtime.js';
import { decodeQueueEvent, encodeQueueEvent, INLINE_EVENT_BYTES, MAX_EVENT_PAYLOAD_BYTES, type EventPayloadBucket, type EventPayloadReference } from '../src/event-transport.js';

const base: PlatformEvent = {
  id: '11111111-1111-4111-8111-111111111111', businessId: '22222222-2222-4222-8222-222222222222',
  type: 'billing.invoice-issued.v1', producer: 'billing', version: 1,
  occurredAt: '2026-10-04T10:00:00Z', correlationId: 'transport-test', data: { payload: '' },
};
function sizedEvent(bytes: number): PlatformEvent {
  return { ...base, data: { payload: 'a'.repeat(bytes - Buffer.byteLength(JSON.stringify(base))) } };
}
function storage() {
  const objects = new Map<string, Uint8Array>();
  let writes = 0;
  const bucket: EventPayloadBucket = {
    async put(key, bytes, options) {
      assert.equal(options.onlyIf.get('if-none-match'), '*');
      if (objects.has(key)) return null;
      objects.set(key, Uint8Array.from(bytes)); writes++; return {};
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
    },
  };
  return { objects, bucket, get writes() { return writes; } };
}

test('inline byte boundary is inclusive; larger UTF-8 JSON offloads to a small private reference', async () => {
  const memory = storage();
  await withCloudflareInvocation({ EVENT_PAYLOADS: memory.bucket }, async () => {
    const inline = sizedEvent(INLINE_EVENT_BYTES);
    assert.equal(Buffer.byteLength(JSON.stringify(inline)), INLINE_EVENT_BYTES);
    assert.deepEqual(await encodeQueueEvent(inline), inline);
    assert.equal(memory.writes, 0);
    const large = { ...base, data: { payload: 'é'.repeat(50_000) } };
    assert.ok(JSON.stringify(large).length < INLINE_EVENT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > INLINE_EVENT_BYTES);
    const reference = await encodeQueueEvent(large) as EventPayloadReference;
    assert.equal(reference.transport, 'tuts.event-payload');
    assert.equal(reference.key, `v1/billing/${base.businessId}/${base.id}.json`);
    assert.ok(Buffer.byteLength(JSON.stringify(reference)) < 1000);
    assert.deepEqual(await decodeQueueEvent(reference), large);
    await encodeQueueEvent(large);
    assert.equal(memory.writes, 1);
    assert.equal(memory.objects.size, 1);
  });
});

test('events above 8 MiB and large inline queue messages fail before storage or handlers', async () => {
  const memory = storage();
  await withCloudflareInvocation({ EVENT_PAYLOADS: memory.bucket }, async () => {
    await assert.rejects(encodeQueueEvent(sizedEvent(MAX_EVENT_PAYLOAD_BYTES + 1)), /size limit/);
    await assert.rejects(decodeQueueEvent(sizedEvent(INLINE_EVENT_BYTES + 1)), /must use private/);
    assert.equal(memory.writes, 0);
    const exactMaximum = await encodeQueueEvent(sizedEvent(MAX_EVENT_PAYLOAD_BYTES));
    assert.ok('transport' in exactMaximum);
    assert.deepEqual(await decodeQueueEvent(exactMaximum), sizedEvent(MAX_EVENT_PAYLOAD_BYTES));
  });
});

test('consumer rejects tampered digest, key, identity, version, and missing objects', async () => {
  const memory = storage();
  await withCloudflareInvocation({ EVENT_PAYLOADS: memory.bucket }, async () => {
    const reference = await encodeQueueEvent(sizedEvent(INLINE_EVENT_BYTES + 1)) as EventPayloadReference;
    await assert.rejects(decodeQueueEvent({ ...reference, sha256: '0'.repeat(64) }), /digest mismatch/);
    await assert.rejects(decodeQueueEvent({ ...reference, key: '../public-file' }), /Invalid private event key/);
    await assert.rejects(decodeQueueEvent({ ...reference, version: 2 }));
    const other = '33333333-3333-4333-8333-333333333333';
    const wrongIdentity = { ...reference, businessId: other, key: `v1/billing/${other}/${base.id}.json` };
    memory.objects.set(wrongIdentity.key, memory.objects.get(reference.key)!);
    await assert.rejects(decodeQueueEvent(wrongIdentity), /identity does not match/);
    memory.objects.delete(reference.key);
    await assert.rejects(decodeQueueEvent(reference), /payload is unavailable/);
  });
});

test('consumer bounds declared and actual streamed size before parsing', async () => {
  const memory = storage();
  await withCloudflareInvocation({ EVENT_PAYLOADS: memory.bucket }, async () => {
    const reference = await encodeQueueEvent(sizedEvent(INLINE_EVENT_BYTES + 1)) as EventPayloadReference;
    let cancelled = 0;
    memory.bucket.get = async () => ({ size: MAX_EVENT_PAYLOAD_BYTES + 1, body: new ReadableStream({ cancel() { cancelled++; } }) });
    await assert.rejects(decodeQueueEvent(reference), /size bounds/);
    assert.equal(cancelled, 1);
    memory.bucket.get = async () => ({ size: 1, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2)); }, cancel() { cancelled++; } }) });
    await assert.rejects(decodeQueueEvent(reference), /size bounds/);
    assert.equal(cancelled, 2);
    memory.bucket.get = async () => ({ size: 2, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); c.close(); } }) });
    await assert.rejects(decodeQueueEvent(reference), /size does not match/);
  });
});

test('offloaded partial fanout retries immutable storage and inbox deduplicates delivered references', async () => {
  const memory = storage();
  const event = sizedEvent(800_000);
  let published = false, fail = true, notifications = 0, handled = 0;
  const inbox = new Set<string>();
  const consumer = new EventBus({ async withTenant(businessId: string, work: (tx: PoolClient) => Promise<void>) {
    assert.equal(businessId, event.businessId);
    await work({ async query() { if (inbox.has(event.id)) return { rowCount: 0 }; inbox.add(event.id); return { rowCount: 1 }; } } as unknown as PoolClient);
  } } as Database, { name: 'payments', port: 0, controllers: [], migrationsDir: '' });
  consumer.subscribe(event.type, async fullEvent => { assert.deepEqual(fullEvent, event); handled++; });
  const producer = new EventBus({ async transaction(work: (tx: PoolClient) => Promise<void>) {
    let updated = false;
    await work({ async query(sql: string) { if (sql.startsWith('UPDATE')) updated = true; return { rows: published ? [] : [{ id: event.id, event }] }; } } as unknown as PoolClient);
    published = updated || published;
  } } as Database, { name: 'billing', port: 0, controllers: [], migrationsDir: '' });
  await withCloudflareInvocation({
    EVENT_PAYLOADS: memory.bucket,
    EVENTS_PAYMENTS: { async send(reference: unknown) { assert.ok(reference && typeof reference === 'object' && 'transport' in reference); await consumer.consumeEvent(reference); } },
    EVENTS_NOTIFICATIONS: { async send() { if (fail) throw new Error('queue unavailable'); notifications++; } },
  }, async () => {
    await assert.rejects(producer.flushOutbox(), /queue unavailable/);
    assert.equal(published, false);
    assert.equal(handled, 1);
    fail = false; await producer.flushOutbox();
    assert.equal(published, true);
    assert.equal(handled, 1);
    assert.equal(notifications, 1);
    assert.equal(memory.writes, 1);
    assert.equal(memory.objects.size, 1);
  });
});

test('storage failure cannot publish an outbox row or send to a queue', async () => {
  let sent = false, updated = false;
  const event = sizedEvent(350_000);
  const producer = new EventBus({ async transaction(work: (tx: PoolClient) => Promise<void>) {
    await work({ async query(sql: string) { if (sql.startsWith('UPDATE')) updated = true; return { rows: [{ id: event.id, event }] }; } } as unknown as PoolClient);
  } } as Database, { name: 'billing', port: 0, controllers: [], migrationsDir: '' });
  await withCloudflareInvocation({ EVENT_PAYLOADS: { async put() { throw new Error('storage unavailable'); }, async get() { return null; } }, EVENTS_PAYMENTS: { async send() { sent = true; } } }, async () => {
    await assert.rejects(producer.flushOutbox(), /storage unavailable/);
    assert.equal(sent, false); assert.equal(updated, false);
  });
});
