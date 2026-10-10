import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext } from "@palladium/contracts";
import type { Database } from "@palladium/service-kit";
import { LearningService } from "../src/learning.js";
import { DiskResourceStorage, R2ResourceStorage, type PrivateUploadsBucket } from "../src/storage.js";

function bucket() {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const fake: PrivateUploadsBucket = {
    async put(key, bytes) { calls.push(`put:${key}`); objects.set(key, Buffer.from(bytes)); },
    async get(key) { calls.push(`get:${key}`); const bytes = objects.get(key); return bytes ? { size: bytes.length, async arrayBuffer() { return new Uint8Array(bytes).buffer; } } : null; },
    async delete(key) { calls.push(`delete:${key}`); objects.delete(key); },
  };
  return { objects, calls, storage: new R2ResourceStorage(fake) };
}
const ctx: RequestContext = { businessId: randomUUID(), sub: "teacher", role: "tutor", entitlements: ["learning"], requestId: randomUUID() };
const upload = { originalname: "worksheet.txt", mimetype: "text/plain", size: 5, buffer: Buffer.from("hello") };

test("private R2 reads use the business namespace and reject traversal", async () => {
  const fake = bucket(), key = randomUUID();
  await fake.storage.put(ctx.businessId, key, upload.buffer, "text/plain");
  assert.equal((await fake.storage.read(ctx.businessId, key)).toString(), "hello");
  await assert.rejects(fake.storage.read(randomUUID(), key), { status: 404 });
  await assert.rejects(fake.storage.read("../other", key), /Invalid private resource key/);
  assert.equal(fake.objects.size, 1);
});
test("SQL upload failure cleans up the private R2 object", async () => {
  const fake = bucket();
  // Authorize/lock first, write the object, then simulate the metadata insert failing.
  const db = { async withTenant(_id: string, work: (tx: unknown) => Promise<unknown>) { return work({ async query(sql: string) { if (sql.startsWith('INSERT INTO resources')) throw new Error('SQL rollback'); return {rows: []}; } }); } } as unknown as Database;
  const service = new LearningService(db); service.storageFactory = () => fake.storage;
  await assert.rejects(service.uploadResource(ctx, { clientId: randomUUID(), title: "Worksheet" }, upload), /SQL rollback/);
  assert.equal(fake.objects.size, 0);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]?.slice(4), fake.calls[1]?.slice(7));
});
test("foreign tenant metadata prevents any R2 read", async () => {
  const fake = bucket();
  const db = { async withTenant(_id: string, work: (tx: unknown) => Promise<unknown>) { return work({ async query() { return { rows: [] }; } }); } } as unknown as Database;
  const service = new LearningService(db); service.storageFactory = () => fake.storage;
  await assert.rejects(service.downloadResource(ctx, randomUUID(), {} as any), { status: 404 });
  assert.deepEqual(fake.calls, []);
});
test("Node disk adapter preserves private write, download and cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuts-private-upload-"));
  try {
    const storage = new DiskResourceStorage(directory), key = randomUUID();
    await storage.put(ctx.businessId, key, upload.buffer);
    const stream = await storage.read(ctx.businessId, key), chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "hello");
    await storage.delete(ctx.businessId, key);
    await assert.rejects(storage.read(ctx.businessId, key), { status: 404 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
