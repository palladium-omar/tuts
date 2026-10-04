import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import type { PlatformEvent } from '@palladium/contracts';
import { EventBus, emitEvent } from '../src/events.js';
import { Database } from '../src/database.js';
import { withCloudflareInvocation } from '../src/runtime.js';

const event: PlatformEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  type: 'billing.invoice-issued.v1', producer: 'billing', version: 1,
  occurredAt: '2026-10-04T10:00:00Z', correlationId: 'synthetic-test', data: {},
};
const options = { name: 'billing', port: 8005, controllers: [], migrationsDir: '' };

test('partial Cloudflare fanout keeps outbox pending and retries all destinations', async () => {
  let published = false;
  let committed = 0;
  const tx = {
    async query(sql: string) {
      if (sql.startsWith('SELECT id,event')) return { rows: published ? [] : [{ id: event.id, event }] };
      if (sql.startsWith('UPDATE service_outbox')) committed++;
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const db = { async transaction(work: (tx: PoolClient) => Promise<void>) {
    const previous = committed;
    try { await work(tx); published = committed > previous; }
    catch (error) { committed = previous; throw error; }
  } } as Database;
  const bus = new EventBus(db, options);
  const sent: string[] = [];
  let fail = true;
  await withCloudflareInvocation({
    EVENTS_PAYMENTS: { async send(body: unknown) { assert.deepEqual(body, event); sent.push('payments'); } },
    EVENTS_NOTIFICATIONS: { async send() { if (fail) throw new Error('transport unavailable'); sent.push('notifications'); } },
  }, async () => {
    await assert.rejects(bus.flushOutbox(), /transport unavailable/);
    assert.equal(published, false);
    assert.equal(committed, 0);
    fail = false;
    await bus.flushOutbox();
    assert.equal(published, true);
    assert.deepEqual(sent, ['payments', 'payments', 'notifications']);
    await bus.flushOutbox();
    assert.equal(committed, 1);
  });
});

test('inbox delivery is tenant scoped, deduplicated, and rolls back on handler failure', async () => {
  const inbox = new Set<string>();
  let handlerCalls = 0;
  let fail = true;
  const tx = { async query(_sql: string, values: string[]) {
    assert.deepEqual(values, ['payments', event.id]);
    if (inbox.has(event.id)) return { rowCount: 0 };
    inbox.add(event.id);
    return { rowCount: 1 };
  } } as unknown as PoolClient;
  const db = { async withTenant(businessId: string, work: (tx: PoolClient) => Promise<void>) {
    assert.equal(businessId, event.businessId);
    const before = new Set(inbox);
    try { await work(tx); }
    catch (error) { inbox.clear(); for (const id of before) inbox.add(id); throw error; }
  } } as Database;
  const bus = new EventBus(db, { ...options, name: 'payments' });
  bus.subscribe(event.type, async () => { handlerCalls++; if (fail) throw new Error('handler failed'); });
  await assert.rejects(bus.consumeEvent(event), /handler failed/);
  assert.equal(inbox.size, 0);
  fail = false;
  await bus.consumeEvent(event);
  await bus.consumeEvent(event);
  assert.equal(handlerCalls, 2);
  assert.equal(inbox.size, 1);
  await assert.rejects(bus.consumeEvent({ ...event, producer: 'payments' }), /Invalid event producer/);
  await assert.rejects(bus.consumeEvent({ ...event, type: 'billing.unknown.v1' }), /No handler/);
});

test('missing intended queue and invalid producer cannot mark publication complete', async () => {
  let updates = 0;
  const tx = { async query(sql: string) {
    if (sql.startsWith('UPDATE')) updates++;
    return { rows: [{ id: event.id, event }] };
  } } as unknown as PoolClient;
  const db = { async transaction(work: (tx: PoolClient) => Promise<void>) { await work(tx); } } as Database;
  await withCloudflareInvocation({}, async () => {
    await assert.rejects(new EventBus(db, options).flushOutbox(), /Missing EVENTS_PAYMENTS/);
    await assert.rejects(new EventBus(db, { ...options, name: 'clients' }).flushOutbox(), /Invalid outbox producer/);
    assert.equal(updates, 0);
    await assert.rejects(emitEvent(tx, { ...event, producer: 'clients' }), /Invalid event producer/);
  });
});

test('Cloudflare transport setup opens no RabbitMQ connection or timer', async () => {
  await withCloudflareInvocation({}, async () => {
    const bus = new EventBus({} as Database, options);
    await bus.start();
    assert.equal(bus.connected, true);
    await bus.onApplicationShutdown();
  });
});
