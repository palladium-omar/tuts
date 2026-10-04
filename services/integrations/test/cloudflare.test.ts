import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareJsonGet } from "../src/security.js";

test("fixed calendar origin uses bounded no-redirect Worker fetch", async () => {
  let called = false;
  const transport: typeof fetch = async (input, init) => {
    called = true;
    assert.equal(input, "https://api.cal.com/v2/me");
    assert.equal(init?.redirect, "manual");
    assert.equal((init?.headers as any).Authorization, "Bearer synthetic");
    assert.ok(init?.signal);
    return Response.json({ data: { id: 123 } });
  };
  assert.deepEqual(await cloudflareJsonGet("https://api.cal.com/v2/me", { Authorization: "Bearer synthetic" }, transport), { data: { id: 123 } });
  assert.equal(called, true);
});
test("arbitrary/private/lookalike calendar origins never issue fetch", async () => {
  const transport: typeof fetch = async () => { throw new Error("Should not fetch"); };
  for (const input of ["https://127.0.0.1/v2/me", "https://api.cal.com.evil.example/me", "https://api.cal.com:8443/v2/me", "https://user@api.cal.com/v2/me", "http://api.cal.com/v2/me"])
    await assert.rejects(cloudflareJsonGet(input, {}, transport), /Custom endpoint pulls are unavailable/);
});
test("calendar responses reject redirects and oversized bodies", async () => {
  await assert.rejects(cloudflareJsonGet("https://api.calendly.com/users/me", {}, async () => new Response(null, { status: 302 })), /redirects/);
  await assert.rejects(cloudflareJsonGet("https://api.calendly.com/users/me", {}, async () => new Response("x".repeat(2 * 1024 * 1024 + 1))), /exceeded/);
});

import { ConnectionsService } from "../src/connections.js";
test("Worker initialization registers import events without starting a poll", () => {
  const previous = process.env.TUTS_RUNTIME; process.env.TUTS_RUNTIME = "cloudflare";
  try {
    const subscriptions: string[] = [];
    const service = new ConnectionsService({} as any, { subscribe(type: string) { subscriptions.push(type); } } as any);
    service.poll = async () => { throw new Error("Initialization must not poll"); };
    service.onModuleInit();
    assert.deepEqual(subscriptions, ["clients.source-synced.v1"]);
    assert.equal((service as any).timer, undefined);
  } finally { if (previous === undefined) delete process.env.TUTS_RUNTIME; else process.env.TUTS_RUNTIME = previous; }
});
