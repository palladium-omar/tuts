# HTTP contract

> **Current contract:** Staff and scoped student/guardian APIs are implemented. Form hooks and Cal.com webhooks use separate connection secrets/signatures. See the generated [route inventory](../service-inventory.md), [security model](security.md) and [audit](../reviews/2026-10-10-platform-audit.md). The documented OpenAPI endpoint currently returns 404 in the audited Node runtime; controller/schema references are the available API source.

External prefix: `/api/{service}/v1/...`. Gateway removes `/api/{service}` before forwarding. Platform authentication is exposed at `/api/platform/auth/*`; platform session/business endpoints are under `/v1`. APIs return JSON. Document endpoints in each service's generated OpenAPI document.

## Authentication and tenant context

1. Better Auth in platform owns browser sign-in/session cookies. Gateway forwards platform/auth responses including every Set-Cookie header.
2. A business request includes `X-Business-Id`. Gateway asks platform's protected `/internal/context` endpoint to validate the session, membership and feature access. This internal call requires a dedicated gateway secret.
3. Gateway issues a 60-second Ed25519-signed JWT with issuer `palladium-gateway`, audience `palladium-services`, and claims `sub`, `businessId`, `role`, `entitlements`, `requestId`, `iat`, `exp`, resolved `permissions`, `accessScope`, `studentIds` and `policyVersion`.
4. Domain services verify the signature using a public key, expiry, issuer and audience, then verify their own entitlement, explicit action permissions, role requirements and student resource scope. They discard unsigned user context headers. The gateway overwrites client-supplied Authorization/context headers for browser session traffic.
5. Authorized service-to-service reads forward the short-lived verified context over the private service network. Services have verification keys only and cannot mint user tokens. External machine/API credentials are a later explicit platform feature, not implicitly supported by browser cookies.

Platform endpoints that create/select a business validate the session directly because a selected business may not yet exist. Health endpoints are public at the domain layer. The integrations form-hook route is public to the browser-session gateway middleware but validates a high-entropy, connection-scoped bearer secret in the integrations service. It is capped at 1 MB at gateway JSON parsing. Cal.com webhook ingress validates its connection-specific HMAC and deduplicates receipts. Other provider webhooks require provider-specific signature verification; none is enabled for payment providers today. Public routes and gateway bypasses must remain narrow.

## Errors

Use HTTP 400 for invalid input, 401 for absent/invalid authentication, 403 for missing membership/feature/permission, 404 for resources absent within the authorized business, 409 for incompatible state or duplicate key, 422 for unavailable provider capability, and 503 for unavailable dependencies. A normal error has `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`. Never return database errors, keys or tokens.

## Writes and retries

Financial mutations require an `Idempotency-Key`, scoped to business and operation. Reusing a key with a different normalized request returns 409. Transport retries reuse the same key. Provider request keys derive from persisted attempt IDs. Server-generated UUIDs identify records. Timestamps use ISO-8601 UTC; business timezone remains separate configuration for recurring schedules.

List responses use `{ "items": [...] }`; object responses use `{ "item": ... }`. Initial lists are bounded and must not silently become unbounded. Breaking contracts create `/v2` rather than changing `/v1` behavior. OpenAPI and examples describe currently implemented behavior; planned routes must be labeled planned.

## Caching and time bounds

Protected requests still validate authorization server-side even when the browser has a short-lived presentation cache. Private recovery/auth routes and downloads declare no-store; general domain responses do not yet have a consistent gateway-level private/no-store policy. See audit S-02 before adding edge caching. APIs have bounded request/body/provider deadlines; server timings identify authentication versus target-service work. Cursor/offset limits and resource coverage are endpoint-specific.
