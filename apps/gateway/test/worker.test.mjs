import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import worker from "../src/worker.ts";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
const pem = await exportPKCS8(privateKey);
const businessId = "11111111-1111-4111-8111-111111111111";
const otherBusinessId = "22222222-2222-4222-8222-222222222222";
const origin = "https://tuts.example.test";

function fixture(options = {}) {
  const calls = [];
  const context = {
    sub: "staff-user", businessId, role: "owner", entitlements: ["clients", "learning"],
    ...options.context,
  };
  const env = {
    CONTEXT_PRIVATE_KEY: pem,
    PLATFORM_INTERNAL_SECRET: "test-internal-secret",
    INTERNAL_RUNTIME_SECRET: "test-runtime-secret-at-least-32-characters",
    PUBLIC_APP_URL: origin,
    PUBLIC_GATEWAY_URL: origin,
    ASSETS: { async fetch(req) { calls.push({ name: "assets", req }); return new Response("static app"); } },
  };
  for (const name of ["platform", "clients", "scheduling", "learning", "billing", "payments", "notifications", "integrations", "planning", "reporting"]) {
    env[name.toUpperCase()] = {
      async fetch(req) {
        const body = req.body ? await req.text() : "";
        calls.push({ name, req, body });
        if (new URL(req.url).pathname === "/internal/context")
          return options.identityResponse?.() ?? Response.json({ item: context });
        return options.response?.(req) ?? Response.json({ item: "ok" });
      },
    };
  }
  const request = (path, init = {}) => new Request(`${origin}${path}`, init);
  return { env, calls, request };
}

test("assets and health are ordinary public browser routes", async () => {
  const f = fixture();
  assert.equal(await (await worker.fetch(f.request("/?business=test"), f.env)).text(), "static app");
  assert.equal((await (await worker.fetch(f.request("/health"), f.env)).json()).status, "ok");
  assert.deepEqual(f.calls.map((c) => c.name), ["assets"]);
});

test("private, encoded private and unknown API routes never reach bindings", async () => {
  const f = fixture();
  for (const path of ["/internal/context", "/__runtime/events", "/api/platform/internal/context",
    "/api/platform/__runtime/events", "/api/platform/auth/%69nternal/context",
    "/api/clients/v1/%5f%5fruntime/events", "/api/clients/v1/%2finternal/context",
    "/api/platform/auth/%2569nternal/context", "/api/missing/v1/items", "/api/clients/health", "/api"])
    assert.equal((await worker.fetch(f.request(path), f.env)).status, 404, path);
  assert.equal(f.calls.length, 0);
});

test("browser Origin and CSRF checks run before identity and dispatch", async () => {
  const f = fixture();
  assert.equal((await worker.fetch(f.request("/api/platform/auth/sign-in/email", {
    method: "POST", headers: { origin: "https://attacker.example.test" }, body: "{}",
  }), f.env)).status, 403);
  assert.equal((await worker.fetch(f.request("/api/platform/auth/sign-out", { method: "POST" }), f.env)).status, 403);
  assert.equal((await worker.fetch(f.request("/api/clients/v1/clients", { headers: { origin: "null" } }), f.env)).status, 403);
  assert.equal(f.calls.length, 0);
  const preflight = await worker.fetch(f.request("/api/clients/v1/clients", { method: "OPTIONS", headers: { origin } }), f.env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
});

test("tenant headers alone never grant membership; platform denials pass through", async () => {
  const f = fixture({ identityResponse: () => Response.json({ error: { code: "membership_required" } }, { status: 403 }) });
  assert.equal((await worker.fetch(f.request("/api/clients/v1/clients"), f.env)).status, 400);
  const denied = await worker.fetch(f.request("/api/clients/v1/clients", {
    headers: { "x-business-id": otherBusinessId, "x-user-id": "owner", "x-role": "owner" },
  }), f.env);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "membership_required");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(f.calls[0].body), { businessId: otherBusinessId });
});

test("disabled features and mismatched returned tenants cannot reach services", async () => {
  const disabled = fixture({ context: { entitlements: [] } });
  const mismatch = fixture({ context: { businessId: otherBusinessId } });
  for (const [f, status] of [[disabled, 403], [mismatch, 503]]) {
    assert.equal((await worker.fetch(f.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), f.env)).status, status);
    assert.equal(f.calls.length, 1);
  }
});

test("verified tenant context replaces spoofed headers; path/query/body and cookies survive", async () => {
  const f = fixture();
  const response = await worker.fetch(f.request("/api/clients/v1/clients?limit=20", {
    method: "POST", headers: {
      origin, cookie: "session=opaque", "x-business-id": businessId,
      authorization: "Bearer attacker", "x-platform-internal-secret": "attacker",
      "x-user-id": "attacker", "x-role": "admin", "x-entitlements": "billing",
      "x-context-user": "attacker", "x-request-id": "attacker",
      "x-real-ip": "spoofed", "cf-connecting-ip": "203.0.113.15",
      "x-forwarded-for": "spoofed", forwarded: "for=spoofed", "idempotency-key": "request-1",
      "content-type": "application/json",
    }, body: JSON.stringify({ name: "Synthetic client" }),
  }), f.env);
  assert.equal(response.status, 200);
  const contextCall = f.calls[0];
  assert.equal(contextCall.req.headers.get("x-platform-internal-secret"), f.env.PLATFORM_INTERNAL_SECRET);
  assert.equal(contextCall.req.headers.get("cookie"), "session=opaque");
  const forwarded = f.calls[1];
  assert.equal(forwarded.req.url, "https://clients.internal/v1/clients?limit=20");
  assert.equal(forwarded.body, JSON.stringify({ name: "Synthetic client" }));
  assert.equal(forwarded.req.headers.get("cookie"), "session=opaque");
  assert.equal(forwarded.req.headers.get("idempotency-key"), "request-1");
  assert.equal(forwarded.req.headers.get("x-real-ip"), "203.0.113.15");
  for (const name of ["x-platform-internal-secret", "x-user-id", "x-role", "x-entitlements", "x-business-id",
    "x-context-user", "x-forwarded-for", "forwarded", "cf-connecting-ip"])
    assert.equal(forwarded.req.headers.get(name), null, name);
  const { payload } = await jwtVerify(forwarded.req.headers.get("authorization").slice(7), publicKey, {
    issuer: "palladium-gateway", audience: "palladium-services", algorithms: ["EdDSA"],
  });
  assert.equal(payload.businessId, businessId);
  assert.equal(payload.sub, "staff-user");
  assert.equal(payload.role, "owner");
  assert.notEqual(payload.requestId, "attacker");
  assert.equal(payload.requestId, forwarded.req.headers.get("x-request-id"));
  assert.equal(payload.requestId, contextCall.req.headers.get("x-request-id"));
  assert.equal(payload.requestId, response.headers.get("x-request-id"));
  assert.equal(payload.exp - payload.iat, 60);
});

test("platform auth strips spoofed authorization/IP and preserves multiple session cookies and status", async () => {
  const f = fixture({ response: () => {
    const headers = new Headers({ "content-type": "application/json", vary: "Accept-Encoding", "access-control-allow-origin": "*" });
    headers.append("set-cookie", "session=one; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    headers.append("set-cookie", "session_data=two; Path=/; HttpOnly; Secure; SameSite=Lax");
    return new Response('{"ok":true}', { status: 201, headers });
  } });
  const response = await worker.fetch(f.request("/api/platform/auth/sign-in/email", {
    method: "POST", headers: { origin, "x-real-ip": "attacker", authorization: "Bearer attacker", "x-platform-internal-secret": "attacker" }, body: "{}",
  }), f.env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.getSetCookie()[0], /Expires=Wed, 21 Oct/);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.match(response.headers.get("vary"), /Accept-Encoding, Origin/);
  for (const name of ["authorization", "x-real-ip", "x-platform-internal-secret"])
    assert.equal(f.calls[0].req.headers.get(name), null);
});

test("connector hooks retain only their connector authorization without browser sessions", async () => {
  const f = fixture();
  const response = await worker.fetch(f.request(`/api/integrations/hooks/${businessId}/connection`, {
    method: "POST", headers: {
      authorization: "Bearer connector-secret", cookie: "session=staff", "x-business-id": otherBusinessId,
      "x-platform-internal-secret": "attacker", "x-user-id": "attacker", "x-role": "owner",
    }, body: "{}",
  }), f.env);
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, "integrations");
  assert.equal(f.calls[0].req.url, `https://integrations.internal/hooks/${businessId}/connection`);
  assert.equal(f.calls[0].req.headers.get("authorization"), "Bearer connector-secret");
  for (const name of ["cookie", "x-business-id", "x-platform-internal-secret", "x-user-id", "x-role"])
    assert.equal(f.calls[0].req.headers.get(name), null);
});

test("known oversized bodies are rejected before identity or service dispatch", async () => {
  const f = fixture();
  const response = await worker.fetch(f.request("/api/learning/v1/resources", {
    method: "POST", headers: { origin, "x-business-id": businessId, "content-length": String(25 * 1024 * 1024 + 1) }, body: "small",
  }), f.env);
  assert.equal(response.status, 413);
  assert.equal(f.calls.length, 0);
});

test("unknown-length streamed bodies are bounded for uploads and connector hooks", async () => {
  for (const [path, limit] of [["/api/platform/auth/sign-in/email", 25 * 1024 * 1024], [`/api/integrations/hooks/${businessId}/connection`, 1024 * 1024]]) {
    const f = fixture();
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    });
    const response = await worker.fetch(f.request(path, { method: "POST", headers: { origin }, body, duplex: "half" }), f.env);
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
  }
});

test("downstream errors, invalid context, and upstream HTTP errors have distinct statuses", async () => {
  const invalid = fixture({ context: { role: "invalid" } });
  assert.equal((await worker.fetch(invalid.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), invalid.env)).status, 503);
  const broken = fixture();
  broken.env.PLATFORM.fetch = async () => { throw new Error("unavailable"); };
  assert.equal((await worker.fetch(broken.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), broken.env)).status, 503);
  const downstream = fixture();
  downstream.env.CLIENTS.fetch = async () => { throw new Error("unavailable"); };
  const unavailable = await worker.fetch(downstream.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), downstream.env);
  assert.equal((await unavailable.json()).error.code, "service_unavailable");
  const conflict = fixture({ response: () => Response.json({ error: { code: "conflict" } }, { status: 409 }) });
  const response = await worker.fetch(conflict.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), conflict.env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "conflict");
});

test("hung identity and domain bindings time out without waiting for a response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const identity = fixture();
  identity.env.PLATFORM.fetch = () => new Promise(() => {});
  const pendingIdentity = worker.fetch(identity.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), identity.env);
  t.mock.timers.tick(5000);
  assert.equal((await pendingIdentity).status, 503);
  const domain = fixture();
  domain.env.PLATFORM.fetch = () => new Promise(() => {});
  const pendingDomain = worker.fetch(domain.request("/api/platform/auth/get-session"), domain.env);
  t.mock.timers.tick(30_000);
  assert.equal((await pendingDomain).status, 503);
});

test("identity JSON bodies are bounded and covered by the identity timeout", async (t) => {
  const oversized = fixture({ identityResponse: () => new Response(new Uint8Array(64 * 1024 + 1)) });
  assert.equal((await worker.fetch(oversized.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), oversized.env)).status, 503);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled = fixture({ identityResponse: () => new Response(new ReadableStream({})) });
  const pending = worker.fetch(stalled.request("/api/clients/v1/clients", { headers: { "x-business-id": businessId } }), stalled.env);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal((await pending).status, 503);
});

test("uploads start forwarding before the browser finishes producing the body", async () => {
  const f = fixture();
  let finish;
  let dispatched;
  const reached = new Promise((resolve) => { dispatched = resolve; });
  f.env.PLATFORM.fetch = async (request) => {
    dispatched();
    assert.equal(await request.text(), "firstsecond");
    return new Response("uploaded");
  };
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("first"));
    finish = () => { controller.enqueue(new TextEncoder().encode("second")); controller.close(); };
  } });
  const pending = worker.fetch(f.request("/api/platform/auth/sign-in/email", { method: "POST", headers: { origin }, body, duplex: "half" }), f.env);
  await reached;
  finish();
  assert.equal(await (await pending).text(), "uploaded");
});

test("scheduled ticks validate the shared secret before calling any service", async () => {
  const f = fixture();
  f.env.INTERNAL_RUNTIME_SECRET = "short";
  await assert.rejects(worker.scheduled({}, f.env), /at least 32/);
  assert.equal(f.calls.length, 0);
});

test("scheduled handler ticks all ten services with private bearer authorization", async () => {
  const f = fixture();
  await worker.scheduled({}, f.env);
  assert.equal(f.calls.length, 10);
  assert.equal(new Set(f.calls.map((call) => call.name)).size, 10);
  for (const { name, req } of f.calls) {
    assert.equal(req.method, "POST");
    assert.equal(req.url, `https://${name}.internal/__runtime/tick`);
    assert.equal(req.headers.get("authorization"), `Bearer ${f.env.INTERNAL_RUNTIME_SECRET}`);
  }
});

test("one failed scheduled service does not prevent other ticks and fails the aggregate", async () => {
  const f = fixture();
  f.env.CLIENTS.fetch = async (req) => { f.calls.push({ name: "clients", req }); return new Response("unavailable", { status: 503 }); };
  await assert.rejects(worker.scheduled({}, f.env), /Scheduled service jobs failed/);
  assert.equal(f.calls.length, 10);
});

test("scheduled ticks use one binding at a time and release each response before the next", async () => {
  const f = fixture();
  let active = 0;
  let maxActive = 0;
  let finished = 0;
  for (const name of ["platform", "clients", "scheduling", "learning", "billing", "payments", "notifications", "integrations", "planning", "reporting"]) {
    f.env[name.toUpperCase()].fetch = async (req) => {
      assert.equal(finished, f.calls.length, "previous response must be released");
      f.calls.push({ name, req });
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      return new Response(new ReadableStream({
        cancel() { active--; finished++; },
      }));
    };
  }
  await worker.scheduled({}, f.env);
  assert.equal(maxActive, 1);
  assert.equal(finished, 10);
  assert.equal(active, 0);
});

test("every public response receives the existing security headers without merging session cookies", async () => {
  const expected = {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  const f = fixture({ response: () => {
    const headers = new Headers({ "x-frame-options": "SAMEORIGIN" });
    headers.append("set-cookie", "session=one; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    headers.append("set-cookie", "session_data=two; Path=/; HttpOnly; Secure");
    return new Response("signed in", { status: 201, headers });
  } });
  const responses = [
    await worker.fetch(f.request("/"), f.env),
    await worker.fetch(f.request("/health"), f.env),
    await worker.fetch(f.request("/internal/context"), f.env),
    await worker.fetch(f.request("/api/clients/v1/clients"), f.env),
    await worker.fetch(f.request("/api/platform/auth/sign-out", { method: "POST" }), f.env),
    await worker.fetch(f.request("/api/platform/auth/get-session", { headers: { origin: "https://attacker.example.test" } }), f.env),
    await worker.fetch(f.request("/api/platform/auth/get-session"), f.env),
  ];
  const broken = fixture();
  broken.env.ASSETS.fetch = async () => { throw new Error("broken static binding"); };
  responses.push(await worker.fetch(broken.request("/"), broken.env));
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 404, 400, 403, 403, 201, 503]);
  for (const [index, response] of responses.entries())
    for (const [name, value] of Object.entries(expected))
      assert.equal(response.headers.get(name), name === "referrer-policy" && [3,4,5,6].includes(index) ? "no-referrer" : value);
  const cookies = responses[6].headers.getSetCookie();
  assert.deepEqual(cookies, [
    "session=one; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
    "session_data=two; Path=/; HttpOnly; Secure",
  ]);
  assert.equal(await responses[6].text(), "signed in");
});

test('response timings distinguish verified identity from service work without exposing credentials',async()=>{
 const f=fixture();
 const response=await worker.fetch(f.request('/api/clients/v1/clients',{headers:{'x-business-id':businessId,cookie:'private-session'}}),f.env);
 assert.equal(response.status,200);
 assert.match(response.headers.get('server-timing'),/^gateway;dur=\d+, identity;dur=\d+, service;dur=\d+$/);
 assert.doesNotMatch(response.headers.get('server-timing'),/private-session|11111111/);
 assert.match(response.headers.get('access-control-expose-headers'),/Server-Timing/);
});

test('all API successes and errors are private and HTML supports a generated hash CSP', async()=>{
 const f=fixture();f.env.CONTENT_SECURITY_POLICY="default-src 'self'; script-src 'self' 'sha256-test'";
 for(const path of ['/api/platform/v1/session','/api/clients/v1/clients','/api/missing/v1/items']){
  const response=await worker.fetch(f.request(path),f.env);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/sha256-test/);
 }
 const html=await worker.fetch(f.request('/'),f.env);assert.match(html.headers.get('content-security-policy'),/default-src/);assert.equal(html.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=()');
});
