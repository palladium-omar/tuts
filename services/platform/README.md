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

New local/nonproduction businesses receive `clients`, `scheduling`, `learning`,
`billing`, `payments`, `notifications`, `integrations`. At startup only when `NODE_ENV=development`, existing local businesses also receive `integrations` using tenant-scoped updates. Production businesses receive **no paid
entitlements**. Production subscription/admin provisioning is not implemented,
and there is no business self-service entitlement endpoint. The global identity
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
