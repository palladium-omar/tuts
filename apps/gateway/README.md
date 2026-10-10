# Gateway

The Node development/container entry is `src/main.ts`; Cloudflare production uses `src/worker.ts`. They are separate transports over the same service contracts. Local port is 8080.

The gateway owns routing, trusted origin handling, session/membership verification through Platform, 60-second signed domain context, header sanitization, canonical origin, maintenance and diagnostic timing. It owns no domain database. Cloudflare serves static Next output and uses private service bindings; Node uses configured service URLs/proxies. Provider hook exceptions are narrow and authenticated by their owning service. Private `/internal` and runtime paths must not be forwarded publicly.

See [HTTP](../../docs/architecture/http.md), [security](../../docs/architecture/security.md), [system](../../docs/architecture/system.md), [deployment](../../docs/cloudflare-deployment.md) and [open audit findings](../../docs/reviews/2026-10-10-platform-audit.md). Gateway cache/CSP hardening and the Node proxy dependency advisory remain open. Hiding a frontend feature never replaces gateway/domain authorization.

Run `pnpm --filter @palladium/gateway test`, build and typecheck. Worker tests cover protected routing, origin/header boundaries, cookie forwarding and runtime handling; they are not a real hosted authentication/browser test.
