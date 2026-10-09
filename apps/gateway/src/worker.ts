import { importPKCS8, SignJWT } from "jose";
import { requestContextSchema, serviceNames } from "@palladium/contracts";
import { diagnosticId, currentDiagnosticId, diagnosticBusiness, logDiagnostic, withDiagnostics } from "@palladium/service-kit/diagnostics";

/** Domain Workers are private service bindings; only this Worker has ingress. */
export interface FetchBinding {
  fetch(request: Request): Promise<Response>;
}
export interface GatewayEnv {
  PLATFORM: FetchBinding;
  CLIENTS: FetchBinding;
  SCHEDULING: FetchBinding;
  LEARNING: FetchBinding;
  BILLING: FetchBinding;
  PAYMENTS: FetchBinding;
  NOTIFICATIONS: FetchBinding;
  INTEGRATIONS: FetchBinding;
  ASSETS: FetchBinding;
  CONTEXT_PRIVATE_KEY: string;
  PLATFORM_INTERNAL_SECRET: string;
  INTERNAL_RUNTIME_SECRET: string;
  PUBLIC_APP_URL: string;
  PUBLIC_GATEWAY_URL: string;
  TUTS_MAINTENANCE?: string;
}

const BODY_LIMIT = 25 * 1024 * 1024;
const HOOK_BODY_LIMIT = 1024 * 1024;
const keys = new WeakMap<GatewayEnv, ReturnType<typeof importPKCS8>>();
const trustedHeaderNames = new Set([
  "authorization", "cookie", "x-platform-internal-secret", "x-auth-mail-secret", "x-business-id",
  "x-user-id", "x-role", "x-entitlements", "x-context", "x-request-id",
  "x-real-ip", "forwarded", "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length",
]);

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
function notFound(): Response {
  return error(404, "route_not_found", "Unknown API route");
}
function sanitizedHeaders(request: Request, hook = false): Headers {
  const headers = new Headers(request.headers);
  const connectionHeaders = headers.get("connection")?.split(",") ?? [];
  for (const header of connectionHeaders) headers.delete(header.trim());
  for (const header of [...headers.keys()]) {
    if (trustedHeaderNames.has(header) || header.startsWith("x-forwarded-") ||
        header.startsWith("cf-") || header.startsWith("x-context-")) {
      headers.delete(header);
    }
  }
  if (!hook && request.headers.has("cookie"))
    headers.set("cookie", request.headers.get("cookie")!);
  // Connector secrets are the public hooks' authentication contract. They are
  // never allowed to become staff/service authorization on any other route.
  if (hook && request.headers.has("authorization"))
    headers.set("authorization", request.headers.get("authorization")!);
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-real-ip", clientIp);
  return headers;
}

/** Reject paths that a downstream router could reinterpret as private routes. */
function safePath(path: string): boolean {
  try {
    const decoded = decodeURIComponent(path);
    if (/%|\\/.test(decoded) || /%2f|%5c/i.test(path)) return false;
    return !decoded.split("/").some((part) =>
      [".", "..", "internal", "__runtime"].includes(part.toLowerCase()));
  } catch {
    return false;
  }
}

class BodyTooLarge extends Error {}

/** Keep uploads streaming while enforcing a bound even without Content-Length. */
function limitedBody(
  body: ReadableStream<Uint8Array>, limit: number,
  fail: (reason: Error) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { controller.close(); return; }
        received += chunk.value.byteLength;
        if (received > limit) {
          const reason = new BodyTooLarge();
          fail(reason);
          controller.error(reason);
          void reader.cancel(reason).catch(() => {});
          return;
        }
        controller.enqueue(chunk.value);
      } catch (reason) {
        const failure = reason instanceof Error ? reason : new Error("Body read failed");
        fail(failure);
        controller.error(failure);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

async function boundFetch(
  binding: FetchBinding, url: string, request: Request,
  headers: Headers, limit: number, timeoutMs: number, bufferResponse = false,
): Promise<Response> {
  const abort = new AbortController();
  let fail!: (reason: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  const stop = (reason: Error) => { fail(reason); abort.abort(reason); };
  const timer = setTimeout(() => stop(new Error("Service timed out")), timeoutMs);
  const onAbort = () => stop(new Error("Client disconnected"));
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method, headers, signal: abort.signal, redirect: "manual",
      ...(request.body && !["GET", "HEAD"].includes(request.method)
        ? { body: limitedBody(request.body, limit, stop), duplex: "half" as const }
        : {}),
    };
    const pending = binding.fetch(new Request(url, init)).then(async (response) => {
      if (!bufferResponse || !response.body) return response;
      // Only the small identity response is buffered. Its body must also obey
      // the identity deadline; a stalled JSON stream cannot pin a request.
      const body = await new Response(limitedBody(response.body, limit, stop)).arrayBuffer();
      return new Response(body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    });
    return await Promise.race([pending, failure]);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  // Set-Cookie cannot be comma joined: Expires itself contains a comma.
  const cookies = response.headers.getSetCookie();
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

function responseWithSecurityHeaders(response: Response, sensitive = false): Response {
  const headers = copyResponseHeaders(response);
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", sensitive ? "no-referrer" : "strict-origin-when-cross-origin");
  if (sensitive) {
    headers.set("Cache-Control", "no-store");
    headers.set("Pragma", "no-cache");
  }
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

function responseWithCors(response: Response, origin?: string): Response {
  const headers = copyResponseHeaders(response);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    const vary = headers.get("vary");
    if (!vary?.split(",").some((part) => part.trim().toLowerCase() === "origin"))
      headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  }
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Business-Id, Idempotency-Key");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

function canonicalPageRedirect(request: Request, url: URL, env: GatewayEnv): Response | undefined {
  if (url.host !== "tuts-palladium.pages.dev" || !["GET", "HEAD"].includes(request.method)) return;
  const destination = request.headers.get("sec-fetch-dest");
  const pageNavigation = destination === "document" || (!destination &&
    (request.method === "HEAD" || request.headers.get("accept")?.includes("text/html")));
  if (!pageNavigation || /^\/(?:api|health|_next)(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return;
  const configured = new URL(env.PUBLIC_APP_URL);
  if (configured.protocol !== "https:" || configured.host !== "tuts.palladiumscholars.com") return;
  const target = new URL("https://tuts.palladiumscholars.com");
  // Assign components to a fixed origin: a pathname beginning // must never
  // become a scheme-relative URL pointing at a caller-selected hostname.
  target.pathname = url.pathname;
  target.search = url.search;
  return new Response(null, { status: 308, headers: { location: target.href } });
}

function maintenanceResponse(request: Request, env: GatewayEnv): Response {
  const url = new URL(request.url);
  // Preserve the established document redirect without calling any binding.
  if (safePath(url.pathname)) {
    const redirect = canonicalPageRedirect(request, url, env);
    if (redirect) return redirect;
  }
  const headers = new Headers({
    "Cache-Control": "no-store", "Retry-After": "60", "X-Tuts-Maintenance": "true",
  });
  const document = !/^\/(?:api|health)(?:\/|$)/i.test(url.pathname) &&
    (request.headers.get("sec-fetch-dest") === "document" ||
      request.headers.get("accept")?.includes("text/html"));
  let response: Response;
  if (document) {
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response = new Response(request.method === "HEAD" ? null :
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tuts maintenance</title><style>body{font:18px system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:2rem;color:#18352b;background:#f7faf8}h1{font-size:2rem}p{line-height:1.6}</style><main><h1>We’ll be back shortly</h1><p>Tuts is temporarily unavailable while we restore your workspace. Please try again in a few minutes.</p></main></html>',
      { status: 503, headers });
  } else {
    headers.set("Content-Type", "application/json; charset=utf-8");
    response = new Response(request.method === "HEAD" ? null : JSON.stringify({
      error: { code: "maintenance", message: "Tuts is temporarily unavailable. Please try again shortly." },
    }), { status: 503, headers });
  }
  const origin = request.headers.get("origin");
  const trusted = origin && [new URL(env.PUBLIC_APP_URL).origin, new URL(env.PUBLIC_GATEWAY_URL).origin].includes(origin);
  return responseWithCors(response, trusted ? origin : undefined);
}

async function route(request: Request, env: GatewayEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  if (!safePath(url.pathname)) return notFound();
  const match = /^\/api\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const service = match?.[1];
  const path = match?.[2] ?? "/";
  const hook = service === "integrations" && (path === "/hooks" || path.startsWith("/hooks/"));
  const origin = request.headers.get("origin");
  if (!hook) {
    if (origin && ![new URL(env.PUBLIC_APP_URL).origin, new URL(env.PUBLIC_GATEWAY_URL).origin].includes(origin))
      return error(403, "origin_denied", "Origin not permitted");
    if (request.method === "OPTIONS") return responseWithCors(new Response(null, { status: 204 }), origin ?? undefined);
    if (!["GET", "HEAD"].includes(request.method) && !origin)
      return error(403, "origin_required", "A trusted Origin header is required");
  }
  const decorate = (response: Response) => hook ? response : responseWithCors(response, origin ?? undefined);
  if (url.pathname === "/health")
    return decorate(Response.json({ service: "gateway", status: "ok" }));
  if (!url.pathname.startsWith("/api/") && url.pathname !== "/api")
    return decorate(canonicalPageRedirect(request, url, env) ?? await env.ASSETS.fetch(request));
  if (!serviceNames.includes(service as (typeof serviceNames)[number])) return decorate(notFound());
  if (!hook && !path.startsWith("/v1/") && !(service === "platform" && path.startsWith("/auth/")))
    return decorate(notFound());
  const limit = hook ? HOOK_BODY_LIMIT : BODY_LIMIT;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    return decorate(error(413, "body_too_large", "Request body is too large"));
  const headers = sanitizedHeaders(request, hook);
  headers.set("x-request-id", requestId);
  if (service !== "platform" && !hook) {
    const businessId = request.headers.get("x-business-id");
    if (!businessId) return decorate(error(400, "business_required", "Select a business"));
    try {
      if (!env.PLATFORM_INTERNAL_SECRET) throw new Error("Internal identity secret required");
      const contextHeaders = new Headers({
        "content-type": "application/json", cookie: request.headers.get("cookie") ?? "",
        "x-platform-internal-secret": env.PLATFORM_INTERNAL_SECRET,
        "x-request-id": requestId,
      });
      const contextResponse = await boundFetch(env.PLATFORM, "https://platform.internal/internal/context",
        new Request("https://gateway.internal/context", {
          method: "POST", headers: contextHeaders,
          body: JSON.stringify({ businessId }), signal: request.signal,
        }), contextHeaders, 64 * 1024, 5000, true);
      if (!contextResponse.ok) return decorate(contextResponse);
      const { item } = await contextResponse.json() as { item: unknown };
      const context = requestContextSchema.parse({ ...(item as object), requestId });
      if (context.businessId !== businessId) throw new Error("Platform returned a different business");
      if (!context.entitlements.includes(service!))
        return decorate(error(403, "feature_disabled", "Feature is not enabled for this business"));
      diagnosticBusiness(context.businessId);
      let key = keys.get(env);
      if (!key) {
        key = importPKCS8(env.CONTEXT_PRIVATE_KEY.replace(/\\n/g, "\n"), "EdDSA");
        keys.set(env, key);
      }
      const token = await new SignJWT(context).setProtectedHeader({ alg: "EdDSA" })
        .setIssuer("palladium-gateway").setAudience("palladium-services")
        .setIssuedAt().setExpirationTime("60s").sign(await key);
      headers.set("authorization", `Bearer ${token}`);
    } catch (reason) {
      logDiagnostic("error", "identity_failed", { error: reason, target: "platform" });
      return decorate(error(503, "identity_unavailable", "Business access could not be verified"));
    }
  }
  const binding = env[service!.toUpperCase() as Uppercase<(typeof serviceNames)[number]>];
  try {
    return decorate(await boundFetch(binding, `https://${service}.internal${path}${url.search}`,
      request, headers, limit, 30_000));
  } catch (reason) {
    logDiagnostic("error", "upstream_failed", { error: reason, target: service });
    return decorate(reason instanceof BodyTooLarge
      ? error(413, "body_too_large", "Request body is too large")
      : error(503, "service_unavailable", `${service} service is unavailable`));
  }
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const requestId = diagnosticId(); // Public callers cannot forge support references.
    return withDiagnostics({ service: 'gateway', requestId, trigger: 'http' }, async () => {
      const started = Date.now();
      let response: Response;
      try { response = env.TUTS_MAINTENANCE === "true" ? maintenanceResponse(request, env) : await route(request, env, requestId); }
      catch (reason) {
        logDiagnostic('error', 'request_failed', { error: reason });
        response = error(503, "service_unavailable", "Gateway is unavailable");
      }
      const path = new URL(request.url).pathname;
      logDiagnostic(response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info', 'request_completed', {
        status: response.status, method: request.method, route: path, durationMs: Date.now() - started,
      });
      const sensitive = /^\/(?:forgot-password|reset-password)(?:\/|$)/.test(path) || path.startsWith("/api/platform/auth/");
      const secured = responseWithSecurityHeaders(response, sensitive);
      const headers = copyResponseHeaders(secured);
      headers.set('x-request-id', requestId);
      headers.set('access-control-expose-headers', 'X-Request-Id');
      return new Response(secured.body, { status: secured.status, statusText: secured.statusText, headers });
    });
  },
  async scheduled(_event: unknown, env: GatewayEnv): Promise<void> {
    return withDiagnostics({ service: "gateway", requestId: diagnosticId(), trigger: "scheduled" }, async () => {
    if (env.TUTS_MAINTENANCE === "true") return;
    if (typeof env.INTERNAL_RUNTIME_SECRET !== "string" || env.INTERNAL_RUNTIME_SECRET.length < 32)
      throw new Error("Runtime secret must contain at least 32 characters");
    // Service bindings and their nested database/provider calls share the
    // top-level invocation's six pending-connection slots. Tick one at a time.
    let failed = false;
    for (const name of serviceNames) {
      try {
        const url = `https://${name}.internal/__runtime/tick`;
        const headers = new Headers({ authorization: `Bearer ${env.INTERNAL_RUNTIME_SECRET}`, "x-request-id": currentDiagnosticId()! });
        const request = new Request(url, { method: "POST", headers });
        const response = await boundFetch(env[name.toUpperCase() as Uppercase<typeof name>],
          url, request, headers, 64 * 1024, 30_000);
        // The tick result is only a status; consume no provider/tenant data here.
        await response.body?.cancel();
        if (!response.ok) {
          failed = true;
          logDiagnostic("error", "tick_failed", { target: name, status: response.status });
        } else logDiagnostic("info", "tick_completed", { target: name, status: response.status });
      } catch (reason) {
        logDiagnostic("error", "tick_failed", { target: name, error: reason });
        failed = true;
      }
    }
    if (failed) throw new Error("Scheduled service jobs failed");
    });
  },
};
