# Password recovery

Platform owns identity, reset tokens, password changes and sessions. Notifications owns delivery through a replaceable system email provider. The web app composes the public forms; it does not receive provider credentials. Business marketing connections and their delivery setting remain independent.

## Browser flow

1. Sign-in links to `/forgot-password`.
2. The form calls `POST /api/platform/auth/request-password-reset` with `{email,redirectTo}` and a trusted browser Origin.
3. Platform checks system-mail availability uniformly before looking up an account. If unavailable it returns a generic 503. BetterAuth otherwise returns the same confirmation for existing and unknown addresses.
4. For an existing account, BetterAuth creates a random, single-use verification token with a 30-minute expiry, then schedules delivery to Notifications through its private HTTP interface. The response does not await the external mail provider. Workers retain the task through `waitUntil` and close invocation database pools after registered tasks settle; Node keeps tasks registered until they finish. This removes provider latency from account-existence timing differences. Delivery has bounded deadlines and a retry but is not a durable queue.
5. The message links directly to `/reset-password#token=...`. Fragments are not sent in HTTP requests. The page also accepts BetterAuth's query-token redirect format, removes tokens from browser history after capture, and keeps the token only in memory.
6. The reset form checks matching 8–128 character passwords and posts `{token,newPassword}` to `POST /api/platform/auth/reset-password` with the trusted Origin. BetterAuth atomically consumes the token, hashes the password and revokes existing sessions. The user signs in again afterward.

The recovery pages have no external assets, set `no-referrer`, and use no browser storage for secrets. Gateway responses for recovery pages and auth routes use `Cache-Control: no-store`. Do not put reset links or passwords in logs. Query-token fallback reaches the server before the client can remove it; new mail uses fragment links.

## Private service contract

Platform calls the `NOTIFICATIONS` Worker service binding; the Node runtime uses `NOTIFICATIONS_URL`. Both services receive a dedicated `AUTH_MAIL_INTERNAL_SECRET` and requests send it in `X-Auth-Mail-Secret`.

| Route | Request | Response |
|---|---|---|
| `GET /internal/auth-mail/status` | Shared-secret header | `{enabled,available,provider}`; configuration readiness only |
| `POST /internal/auth-mail/password-reset` | Shared-secret header; JSON `{recipientEmail,token}` | `{accepted:true,messageId}` only after provider acceptance |

Notifications validates the secret in constant time, accepts only the fixed reset-message shape and constructs the link from its configured `PUBLIC_APP_URL`. Its initial provider adapter sends to Resend's fixed HTTPS endpoint with bounded deadlines, one retry for transient failures and a stable idempotency key. It never reads Platform tables. The public gateway rejects every `/internal` path and strips inbound `X-Auth-Mail-Secret`; service Workers have no direct public ingress.

## Configuration

`AUTH_MAIL_ENABLED` must be `true` in Platform and Notifications. Set the shared secret in both; only Notifications receives `AUTH_MAIL_PROVIDER=resend`, `AUTH_MAIL_FROM`, and `AUTH_MAIL_API_KEY`. Use a verified sender and a restricted sending key. Credentials stay in ignored private configuration and Worker secrets, never browser bundles or Git.

For Cloudflare, add the private sender fields to `.cloudflare/secrets.json` and set `authMailEnabled: true` in `.cloudflare/deployment.json` only after configuring the real provider. Run configuration generation and deploy Platform and Notifications together. The deployment helper refuses to enable system mail without sender credentials. `ALLOW_OUTBOUND_DELIVERY` continues to control business communications separately.

Migration `services/platform/migrations/004_auth_rate_limit.sql` must precede the Platform rollout. BetterAuth stores shared rate limits in PostgreSQL: reset requests allow three per client IP in five minutes and reset submissions allow five in five minutes. This avoids per-isolate counters on Workers. Database copies must use matching migration versions; the earlier recovery snapshot predates this table and remains a historical backup.

Availability is not an inbox-delivery receipt. BetterAuth preserves its account-neutral confirmation if background delivery fails after readiness checking; only a fixed redacted warning is logged. A generic confirmation must never be reported as proof of delivery. Review provider acceptance and delivery records when diagnosing missing mail. Production now uses a verified dedicated Resend sender with a domain-restricted sending-only credential stored as a deployment secret. The live Forgot password form produced a provider-confirmed delivered email on 10 October 2026. The existing demo business connector is not used for system email. Provider delivery is separate from the owner completing a password change.

The provider binds native fetch to its global receiver and combines deadlines with an AbortController and cleaned timer, without depending on AbortSignal.any. Failures log only a fixed category and numeric provider status; response bodies, recipient addresses and tokens are never logged.

## Authorized manual recovery

When an account owner explicitly requests support, an operator can issue a standard BetterAuth token without changing the password:

```sh
node scripts/issue-password-reset.mjs user@example.com
```

The CLI uses the ordinary Platform role and verified TLS, then writes the reset link to an exclusive private 0600 file under `.cloudflare/auth-mail`. It prints only the file path. Deliver that link through an authorized private channel to the account owner. Issuance does not send an email and does not prove the user has completed the reset. Never open and consume the owner's token as a check, or copy the private file into Git.
