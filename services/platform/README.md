# Platform identity and business service

Owns the only authentication database. Better Auth handles password hashing and
persistent sessions using its real PostgreSQL adapter and the explicit core SQL
migration. No service may read these identity tables directly.

Port: `4001`. Start with the root development workflow. Required secrets are
`BETTER_AUTH_SECRET` and `PLATFORM_INTERNAL_SECRET` (each at least 32 characters).
Set `PUBLIC_APP_URL=http://localhost:3000` and
`PUBLIC_GATEWAY_URL=http://localhost:8080` for the local app. Production requires
HTTPS public URLs. `DATABASE_URL` must use the platform database role; tenant
businesses and memberships force RLS.

For the production deployment, use `NODE_ENV=production` and set both
`PUBLIC_APP_URL` and `PUBLIC_GATEWAY_URL` to
`https://tuts.palladiumscholars.com`. These values are public origins, without an
API path. TLS may terminate at the reverse proxy: the platform constructs auth
requests using its configured HTTPS public URL, explicitly ignores forwarded
host/protocol headers, and sets Secure, HttpOnly, host-only session cookies with
`Path=/` and `SameSite=Lax`. The app and API should use the same public origin so
browser cookie delivery does not depend on cross-site cookie support. Keep the
gateway and platform ports private; expose only the ingress. The ingress must
overwrite `X-Real-IP` with the actual client address and the gateway must preserve
it. Better Auth uses that single trusted header for auth rate limiting and session
IP tracking; untrusted client input must never reach it. For Caddy, configure
`header_up X-Real-IP {remote_host}` on the gateway reverse proxy. Without a valid
IP header, auth rate limiting uses a shared per-path bucket.

## Implemented HTTP API

Gateway external prefix is `/api/platform`; it removes this prefix upstream.

- `POST /auth/sign-up/email`: Better Auth `{name,email,password}`, 8–128 character password; no composition rules.
- `POST /auth/sign-in/email`: Better Auth `{email,password}`.
- `POST /auth/sign-out`: revokes the current persistent session.
- `GET /auth/get-session`: native Better Auth session response.
- `GET /v1/session`: `{item:{user,expiresAt}}`, no session token.
- `GET /v1/businesses`: `{items:[{id,name,role,entitlements,settings,createdAt}]}`, maximum 100.
- `POST /v1/businesses`: `{name,timezone?,profile?,branding?}`, creates owner membership and returns `{item:business}`.
- `PATCH /v1/businesses/:id/settings`: owner/admin only; accepts `profile`, `branding`, `timezone`, `language` and returns `{item:business}`. Branding accepts partial `displayName`, hexadecimal `primaryColor`, `secondaryColor`, `backgroundColor`, `textColor`, optional HTTPS `logoUrl`, and nullable `logoDataUrl`. Logo data URLs must contain PNG, JPEG or WebP image signatures and canonical base64 encoding with at most 256 KiB of image bytes; SVG is rejected. Profile accepts optional `legalName`, `email`, `phone`, HTTP/HTTPS `website`, `taxId` and `address:{line1,line2,city,region,postalCode,country}`. Contact/address values may be null to clear. Nested profile/address/branding patches preserve absent saved values. Rejects unknown keys including entitlements.
- `POST /internal/context`: gateway secret header `X-Platform-Internal-Secret`, browser Cookie, body `{businessId}`. Returns `{item:{sub,businessId,role,entitlements}}`. This route must never be publicly proxied by the gateway.

The native authentication response shapes belong to Better Auth. Object/list
wrappers apply to the platform-owned endpoints. Browser requests use
`credentials:'include'`. Session cookies use `/` so they reach every service at
the gateway. Better Auth's public base path is `/api/platform/auth`; the controller
reconstructs that path after gateway routing and preserves all Set-Cookie headers.
Custom cookie-authenticated mutations require an Origin exactly matching either
public URL. Native Better Auth checks trusted origins itself.

Set `INITIAL_BUSINESS_ENTITLEMENTS` on the platform process to a comma-separated
list of initial features for newly created businesses. The allowed values are
`clients`, `scheduling`, `learning`, `billing`, `payments`, `notifications`, and
`integrations`. The configuration is validated at startup: whitespace is trimmed,
duplicates are removed, and unknown features or empty comma-separated entries
prevent startup. An explicitly empty value grants zero features. For example:

```sh
INITIAL_BUSINESS_ENTITLEMENTS=clients,scheduling,learning,billing,payments,notifications,integrations
```

When this setting is absent, production businesses receive **zero entitlements**;
local/nonproduction businesses retain the full starter set listed above. At
startup only when `NODE_ENV=development`, existing local businesses also receive
`integrations` using tenant-scoped updates. Deployment configuration applies only
to business creation and never changes existing production businesses. Grants
are persisted atomically with the business and owner membership. Business and
settings browser payloads reject entitlement fields. This provisioning policy
grants access to feature APIs; external integrations still require their own
provider configuration. Production subscription/admin provisioning is not
implemented, and there is no business self-service entitlement endpoint. The global identity
business directory contains only user/business IDs for preselection discovery;
role and entitlement reads always require tenant transactions and membership.
No membership invitations, password recovery email transport, email verification
transport or production subscription administration are implemented.

## Checks

`pnpm --filter @palladium/platform typecheck` and
`pnpm --filter @palladium/platform test`.
Unit tests cover validation, production entitlement restrictions and internal
secret authorization. Root integration checks should use a real non-superuser
PostgreSQL role, two users/businesses, register/sign-in/sign-out through the gateway,
and cross-business membership/settings rejection. RLS is not verifiable with a
superuser/BYPASSRLS connection.

Optional real database RLS tests run when `PLATFORM_TEST_DATABASE_URL` points to the
already-migrated service database using its non-superuser runtime role. They use
synthetic fixtures inside a rolled-back transaction and skip without that variable.

Auth integration follows the [Better Auth options](https://better-auth.com/docs/reference/options)
and [server integration](https://better-auth.com/docs/integrations/express) APIs.
The lockfile fixes the installed library version; review its core schema whenever
upgrading Better Auth or enabling a plugin, and add an explicit SQL migration.
The optional authentication integration test also requires `BETTER_AUTH_SECRET`
and `PLATFORM_INTERNAL_SECRET`. It runs real Better Auth registration, failed and
successful login, credential hashing, session lookup and signout/revocation with
PostgreSQL; its synthetic account is deleted in cleanup. Gateway/Nest HTTP routing
is verified separately by the root integration workflow.

Business creation and every settings save emit `platform.business-profile-updated.v1` atomically with `{businessId,name,profile,branding,revision}`. The monotonic per-business revision prevents an older delivery from reverting billing identity. The event contains reusable seller details only. Existing businesses first publish their current identity on their next settings save. Billing owns its projection and freezes identity when issuing each invoice; platform never writes billing SQL.


## Cloudflare runtime

`src/worker.ts` exports this domain as an independent Worker through the shared Nest runtime; `src/main.ts` remains the Node entrypoint. The service retains its own PostgreSQL database, signed caller context, tenant RLS and event contracts. Migrations are applied during deployment, outside requests. Worker secrets and bindings are supplied by the deployment configuration.
