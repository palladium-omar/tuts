# HTTP contract

> **Contract scope:** This describes the shared gateway and service API contract. Signed JWT context and staff authorization are implemented. Student/parent portal routes and relationship-based resource authorization are not yet shipped. Form connector hooks use a connection-specific bearer secret on a dedicated public ingress, not a browser session. The contract may also describe routes for future extensions; consult the [repository status](../../README.md#what-works-today) and service OpenAPI documents for current endpoints.

External prefix: `/api/{service}/v1/...`. Gateway removes `/api/{service}` before forwarding. Platform authentication is exposed at `/api/platform/auth/*`; platform session/business endpoints are under `/v1`. APIs return JSON. Document endpoints in each service's generated OpenAPI document.

## Authentication and tenant context

1. Better Auth in platform owns browser sign-in/session cookies. Gateway forwards platform/auth responses including every Set-Cookie header.
2. A business request includes `X-Business-Id`. Gateway asks platform's protected `/internal/context` endpoint to validate the session, membership and feature access. This internal call requires a dedicated gateway secret.
3. Gateway issues a 60-second Ed25519-signed JWT with issuer `palladium-gateway`, audience `palladium-services`, and claims `sub`, `businessId`, `role`, `entitlements`, `requestId`, `iat`, `exp`.
4. Domain services verify the signature using a public key, expiry, issuer and audience, then verify their own entitlement and role requirements. They discard unsigned user context headers. The gateway overwrites client-supplied Authorization/context headers for browser session traffic.
5. Authorized service-to-service reads forward the short-lived verified context over the private service network. Services have verification keys only and cannot mint user tokens. External machine/API credentials are a later explicit platform feature, not implicitly supported by browser cookies.

Platform endpoints that create/select a business validate the session directly because a selected business may not yet exist. Health endpoints are public at the domain layer. The integrations form-hook route is public to the browser-session gateway middleware but validates a high-entropy, connection-scoped bearer secret in the integrations service. It is capped at 1 MB at gateway JSON parsing. Other provider webhooks require their provider-specific signature verification; none is enabled for the payment providers today. Public routes and gateway bypasses must remain narrow.

## Errors

Use HTTP 400 for invalid input, 401 for absent/invalid authentication, 403 for missing membership/feature/permission, 404 for resources absent within the authorized business, 409 for incompatible state or duplicate key, 422 for unavailable provider capability, and 503 for unavailable dependencies. A normal error has `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`. Never return database errors, keys or tokens.

## Writes and retries

Financial mutations require an `Idempotency-Key`, scoped to business and operation. Reusing a key with a different normalized request returns 409. Transport retries reuse the same key. Provider request keys derive from persisted attempt IDs. Server-generated UUIDs identify records. Timestamps use ISO-8601 UTC; business timezone remains separate configuration for recurring schedules.

List responses use `{ "items": [...] }`; object responses use `{ "item": ... }`. Initial lists are bounded and must not silently become unbounded. Breaking contracts create `/v2` rather than changing `/v1` behavior. OpenAPI and examples describe currently implemented behavior; planned routes must be labeled planned.
