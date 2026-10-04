import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareJsonPost, CommunicationError } from "../src/communication-security.js";

test("Meta adapter fixes origin/path, rejects redirects and carries auth", async () => {
  const transport: typeof fetch = async (input, init) => {
    assert.equal(input, "https://graph.facebook.com/v22.0/123456/messages");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as any).Authorization, "Bearer synthetic");
    return Response.json({ messages: [{ id: "synthetic" }] });
  };
  assert.deepEqual(await cloudflareJsonPost("https://graph.facebook.com/v22.0/123456/messages", {}, { Authorization: "Bearer synthetic" }, transport), { messages: [{ id: "synthetic" }] });
});
test("arbitrary AI/private/lookalike destinations cannot issue fetch", async () => {
  const transport: typeof fetch = async () => { throw new Error("Should not fetch"); };
  for (const input of ["https://127.0.0.1", "https://api.resend.com.evil.example/emails", "https://api.resend.com/other", "https://graph.facebook.com/v22.0/123456/messages?url=private"])
    await assert.rejects(cloudflareJsonPost(input, {}, {}, transport), /unavailable/);
});
test("transport failures and oversized accepted responses remain acceptance unknown", async () => {
  for (const transport of [async () => { throw new Error("network failure"); }, async () => new Response("x".repeat(128 * 1024 + 1))]) {
    await assert.rejects(cloudflareJsonPost("https://api.resend.com/emails", {}, {}, transport), (error: unknown) => error instanceof CommunicationError && error.ambiguous);
  }
});

import { CommunicationWorker } from "../src/communication-worker.js";
import { resolvePublicHost } from "../src/communication-security.js";
test("Worker initialization registers consent handlers without polling", async () => {
  const previous = process.env.TUTS_RUNTIME; process.env.TUTS_RUNTIME = "cloudflare";
  try {
    const subscriptions: string[] = [];
    const worker = new CommunicationWorker({} as any, { subscribe(type: string) { subscriptions.push(type); } } as any);
    worker.onModuleInit();
    assert.deepEqual(subscriptions, ["clients.client-created.v1", "clients.client-updated.v1"]);
    assert.equal((worker as any).interval, undefined);
    await assert.rejects(resolvePublicHost("smtp.example.com"), /unavailable/);
  } finally { if (previous === undefined) delete process.env.TUTS_RUNTIME; else process.env.TUTS_RUNTIME = previous; }
});
