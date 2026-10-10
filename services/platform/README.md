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
- `POST /auth/request-password-reset`: native Better Auth `{email,redirectTo?}`; accepts a trusted app Origin. Returns the same generic success for an existing or unknown address when recovery delivery is configured, or a uniform 503 before email validation/account lookup when unavailable.
- `POST /auth/reset-password`: native Better Auth `{token,newPassword}`; accepts a trusted app Origin. Tokens expire after 30 minutes, are consumed once, and a successful reset revokes all the user's sessions. Password limits remain 8–128 characters.
- `GET /auth/get-session`: native Better Auth session response.
- `GET /v1/session`: `{item:{user,expiresAt}}`, no session token.
- `GET /v1/businesses`: `{items:[{id,name,role,entitlements,settings,createdAt,permissions,accessScope,studentIds,policyVersion:1}]}`, maximum 100. Settings use validated field allowlists. Business scope plus `platform.read` permits the seller profile; other memberships receive only version, timezone, language and branding. Unknown historical settings keys are never returned.
- `POST /v1/businesses`: `{name,timezone?,profile?,branding?}`, creates owner membership and returns `{item:business}`.
- `PATCH /v1/businesses/:id/settings`: owner/admin, business scope and `platform.write` required; accepts `profile`, `branding`, `timezone`, `language` and returns `{item:business}`. Branding accepts partial `displayName`, hexadecimal `primaryColor`, `secondaryColor`, `backgroundColor`, `textColor`, optional HTTPS `logoUrl`, and nullable `logoDataUrl`. Logo data URLs must contain PNG, JPEG or WebP image signatures and canonical base64 encoding with at most 256 KiB of image bytes; SVG is rejected. Profile accepts optional `legalName`, `email`, `phone`, HTTP/HTTPS `website`, `taxId` and `address:{line1,line2,city,region,postalCode,country}`. Contact/address values may be null to clear. Nested profile/address/branding patches preserve absent saved values. Rejects unknown keys including entitlements.
- `POST /internal/context`: gateway secret header `X-Platform-Internal-Secret`, browser Cookie, body `{businessId}`. Returns `{item:{sub,businessId,role,entitlements,permissions,accessScope,studentIds,policyVersion:1}}`. This route must never be publicly proxied by the gateway.

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
No membership invitations, email verification transport or production
subscription administration are implemented.

## Membership capability policy

Apply `005_capability_policy.sql` before issuing modern contexts. Memberships
resolve `permissions_override` when present, including an empty array that denies
all capabilities; null selects `defaultPermissions(role)`. Scope is `business` or
`students`. Student and parent memberships always use student scope. Active
`portal_student_access` relationship records supply their student IDs; a membership
or group without an explicit grant yields no student access. The access table
forces tenant RLS and references the tenant membership. Revoked grants are excluded
from subsequent contexts. Existing signed contexts expire after 60 seconds.

`IdentityService.requireBusinessContext` verifies the browser session's membership
inside a tenant transaction; the global directory only discovers candidate tenant
IDs and cannot grant membership. Missing memberships deny access even when an old
directory row remains. Business creation inserts the owner membership and directory
entry in the same transaction and returns the explicit owner policy preset.

## Password recovery delivery

Platform sends only `{recipientEmail,token}` to the private Notifications endpoint
`POST /internal/auth-mail/password-reset` using `serviceFetch`. Workers require a
`NOTIFICATIONS` service binding; local Node requires `NOTIFICATIONS_URL`.
Set `AUTH_MAIL_ENABLED=true` exactly and a shared `AUTH_MAIL_INTERNAL_SECRET`
(32–512 base64/base64url/hex characters) on Platform and Notifications. Keep this
secret limited to those two services. Notifications owns the global transactional
provider and constructs `/reset-password#token=...` from its configured public app
origin; user callback URLs never control the delivery link. This configuration
is independent of tenant marketing delivery and `ALLOW_OUTBOUND_DELIVERY`.

Every recovery request checks private `GET /internal/auth-mail/status` before
account lookup and requires `available:true`. Disabled mail, invalid/missing
configuration, and a failed status transport return the same generic 503 for all
email inputs. The status check establishes configured availability, not a
guarantee that the provider will accept a later message. Better Auth deliberately
preserves its generic success if delivery subsequently fails, preventing an
existing-account-only error response from exposing account existence. A failure
emits only a fixed, redacted server warning; never log token links, passwords or
provider responses. The public endpoint never returns a recovery token.

Delivery runs through Better Auth's background-task handler, so provider latency
does not delay only existing-account responses. Workers retain delivery and
invocation pool cleanup with `waitUntil`; without that context they await the
tasks before cleanup. Node retains promises until completion in the running
service process. This is bounded asynchronous delivery, not a durable queue:
process termination can lose an in-flight message. Provider acceptance and inbox
delivery still require separate evidence.

Apply `004_auth_rate_limit.sql` before deploying this configuration. Better Auth
stores auth limits in the platform PostgreSQL database, including recovery
request limits of 3 per 5 minutes per trusted client IP and reset limits of 5 per
5 minutes. These limits persist across Worker invocations. The ingress must
continue replacing `X-Real-IP` with the real client address.

For an authorized administrative recovery when transactional mail is unavailable,
build Platform and run `node scripts/issue-password-reset.mjs EMAIL`. The command
uses the configured isolated platform role in `.cloudflare/secrets.json`, verifies
TLS and role privileges, and calls native Better Auth issuance with a local file
delivery callback. It saves the single-use link in an exclusive mode-0600 JSON
file under `.cloudflare/auth-mail/` and prints only the file path. An optional
`--delivery-file PRIVATE_PATH` selects another private output file. It neither
changes the user's password nor sends email; only an explicitly authorized
operator should handle delivery. Never commit or paste this file into logs.

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
