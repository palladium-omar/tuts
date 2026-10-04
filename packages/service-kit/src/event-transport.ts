import { createHash } from 'node:crypto';
import { z } from 'zod';
import { platformEventSchema, type PlatformEvent } from '@palladium/contracts';
import { currentCloudflareBindings } from './runtime.js';

// Leave ample space below Queues' 128,000-byte limit, including metadata.
export const INLINE_EVENT_BYTES = 100_000;
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024 * 1024;
const referenceSchema = z.object({
  transport: z.literal('tuts.event-payload'),
  version: z.literal(1),
  id: platformEventSchema.shape.id,
  businessId: platformEventSchema.shape.businessId,
  producer: platformEventSchema.shape.producer,
  type: platformEventSchema.shape.type,
  sha256: z.string().regex(/^[a-f\d]{64}$/),
  key: z.string().max(200),
}).strict();
export type EventPayloadReference = z.infer<typeof referenceSchema>;
export type QueueEvent = PlatformEvent | EventPayloadReference;
type EventObject = { size: number; body: ReadableStream<Uint8Array> };
export interface EventPayloadBucket {
  put(key: string, bytes: Uint8Array, options: {
    onlyIf: Headers;
    httpMetadata: { contentType: string };
    sha256: string;
  }): Promise<unknown | null>;
  get(key: string): Promise<EventObject | null>;
}
function bucket(): EventPayloadBucket {
  const value = currentCloudflareBindings()?.EVENT_PAYLOADS as EventPayloadBucket | undefined;
  if (!value || typeof value.put !== 'function' || typeof value.get !== 'function') {
    throw new Error('Private EVENT_PAYLOADS storage is required');
  }
  return value;
}
function payloadKey(event: Pick<PlatformEvent, 'producer' | 'businessId' | 'id'>): string {
  return `v1/${event.producer}/${event.businessId}/${event.id}.json`;
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function assertIdentity(reference: EventPayloadReference, event: PlatformEvent): void {
  for (const key of ['id', 'businessId', 'producer', 'type'] as const) {
    if (event[key] !== reference[key]) throw new Error('Stored event identity does not match reference');
  }
  if (event.producer !== event.type.split('.')[0]) throw new Error('Invalid event producer');
}
async function readPayload(storage: EventPayloadBucket, reference: EventPayloadReference): Promise<PlatformEvent> {
  if (reference.key !== payloadKey(reference)) throw new Error('Invalid private event key');
  const object = await storage.get(reference.key);
  if (!object) throw new Error('Private event payload is unavailable');
  if (!Number.isSafeInteger(object.size) || object.size <= 0 || object.size > MAX_EVENT_PAYLOAD_BYTES) {
    await object.body?.cancel().catch(() => {});
    throw new Error('Private event payload exceeds size bounds');
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_EVENT_PAYLOAD_BYTES || size > object.size) throw new Error('Private event payload exceeds size bounds');
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (size !== object.size) throw new Error('Private event payload size does not match metadata');
  const bytes = Buffer.concat(chunks, size);
  if (digest(bytes) !== reference.sha256) throw new Error('Private event payload digest mismatch');
  const event = platformEventSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  assertIdentity(reference, event);
  return event;
}

/** Storage is immutable across partial fanout and duplicate delivery. */
export async function encodeQueueEvent(event: PlatformEvent): Promise<QueueEvent> {
  event = platformEventSchema.parse(event);
  if (event.producer !== event.type.split('.')[0]) throw new Error('Invalid event producer');
  const bytes = Buffer.from(JSON.stringify(event), 'utf8');
  if (bytes.byteLength > MAX_EVENT_PAYLOAD_BYTES) throw new Error('Event exceeds private payload size limit');
  if (bytes.byteLength <= INLINE_EVENT_BYTES) return event;
  const reference: EventPayloadReference = {
    transport: 'tuts.event-payload', version: 1, id: event.id,
    businessId: event.businessId, producer: event.producer, type: event.type,
    sha256: digest(bytes), key: payloadKey(event),
  };
  const storage = bucket();
  const created = await storage.put(reference.key, bytes, {
    onlyIf: new Headers({ 'if-none-match': '*' }),
    httpMetadata: { contentType: 'application/json' }, sha256: reference.sha256,
  });
  // A concurrent attempt or retry may already have stored the event. Verify it
  // rather than replacing immutable data or extending its expiry on duplicates.
  if (created === null) await readPayload(storage, reference);
  return reference;
}

export async function decodeQueueEvent(input: unknown): Promise<PlatformEvent> {
  if (input && typeof input === 'object' && 'transport' in input) {
    const reference = referenceSchema.parse(input);
    return readPayload(bucket(), reference);
  }
  const event = platformEventSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > INLINE_EVENT_BYTES) {
    throw new Error('Large queue event must use private payload storage');
  }
  return event;
}
