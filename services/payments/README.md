# Payments service

> Current cross-service context: [system](../../docs/architecture/system.md), [API/schema inventory](../../docs/service-inventory.md), [security/performance audit](../../docs/reviews/2026-10-10-platform-audit.md). Service descriptions below define APIs and local behavior; provider/configuration readiness is separate.

Independent NestJS process (4006), dedicated PostgreSQL database, `payments` entitlement. Gateway prefix `/api/payments`; service routes use `/v1`. It supports the existing local sandbox simulator and an existing business Stripe account in **test mode only**. PayPal and bank adapters remain unavailable.

## Existing Stripe account and explicit actions

POST `/v1/connections` requires owner/admin and `Idempotency-Key`:

```json
{
  "provider": "stripe",
  "displayName": "My Stripe test account",
  "credentials": { "secretKey": "sk_test_replace_with_your_key" }
}
```

`rk_test_` restricted keys are also accepted; the key needs permission to read its account and create/read Checkout Sessions. Keys must be test secrets, 500 characters maximum, with no newline or punctuation injection. `pk_test_`, `sk_live_`, `rk_live_` and unknown credential fields are rejected. Optional `webhookSecret` may be stored but has no active consumer; webhook capability is false. Connecting saves encrypted credentials and `verificationStatus:"not_verified"`; it never contacts Stripe. Secrets are never returned. New ciphertext binds the business ID with AES-256-GCM authenticated additional data; legacy v1 ciphertext remains readable.

POST `/v1/connections/:id/verify` is an explicit owner/admin action that calls Stripe's authenticated `/v1/account`, validates the account ID, and stores `{accountId,verificationStatus:"verified"}` with `verifiedAt` and a transactional `payments.connection-verified.v1` event containing only connection/account IDs, provider and `simulated:true`. DELETE `/v1/connections/:id` disables it while retaining attempt/provider history; disabled credentials are never used for new requests. This connects the business's own existing test account; Connect/OAuth onboarding and live payments are not implemented.

GET `/v1/providers` returns `{items}` with provider/displayName/available/simulated/mode/reason/capabilities. Stripe availability reflects support in development/test even before a business supplies credentials. Its capabilities are `createCheckout`, `getPayment`, `reconcilePayment`; `verifyWebhook` and `refund` remain false. GET `/v1/connections` returns `{items}` with id/provider/displayName/status/capabilities/mode/config/simulated/verifiedAt/createdAt. Stripe mode is `test`; sandbox mode is `sandbox`. Status is `enabled`, `disabled`, or `unavailable`.

## Checkout and verified refresh

POST `/v1/checkouts` requires owner/admin, `Idempotency-Key`, and exactly `{invoiceId,connectionId}`. Browser-provided amount, currency, payment status, or redirect URLs are rejected. The authoritative issued-invoice event snapshot supplies the full unpaid total. A missing snapshot returns 409 `invoice_snapshot_unavailable`; retry after broker processing. Already paid or partially paid invoices cannot start a new full-total checkout.

The service commits an attempt and its exact provider request before contacting Stripe. It uses hosted Checkout, card payment mode, a single invoice line item, and business/attempt/invoice/generation metadata. Integer minor units are passed unchanged, with lowercase currency codes. This adapter explicitly supports USD, EUR, GBP, CAD, AUD, CHF, AED and MAD; other currencies return 422 until their denomination rules are implemented. Stripe still enforces account/currency/minimum-charge availability.

A trusted `PUBLIC_APP_URL` determines success/cancel redirects to `/?business=<businessId>&view=payments&checkout=<attemptId>&result=success|cancelled`. HTTP is allowed only for localhost development; remote app URLs require HTTPS. These redirects never confirm payment. The returned checkout URL must be HTTPS on `checkout.stripe.com`; provider session IDs and `livemode:false` must identify a test Checkout Session.

GET `/v1/checkouts` and GET `/v1/checkouts/:id` are available to staff. All object responses are `{item}`; lists are `{items}`. Checkout fields:

```text
id, invoiceId, connectionId, provider, providerReference,
amountMinor, currency, status (pending|confirmed), simulated,
mode (test|sandbox), checkoutUrl,
creationStatus (creating|ready|unknown|failed|expired),
lastError, expiresAt, lastRefreshedAt, createdAt, confirmedAt
```

A reference starting `stripe:` is a durable local placeholder; only `cs_test_...` is a verified provider session. `creating` means a live lease is processing the provider request. An expired/interrupted creation lease is exposed as `unknown` so staff can retry safely. Provider errors expose only safe generic codes, not response bodies or credentials.

POST `/v1/checkouts/:id/refresh` is an owner/admin action with no request body. It retrieves the persisted Stripe session directly, then verifies its ID, test mode, payment mode, amount, currency, tenant/attempt/invoice/generation metadata, and complete+paid state before confirmation. An unpaid session remains pending. A verified expired session has creationStatus `expired` and no checkout URL. Missing provider references require retrying creation for the same invoice/connection; refreshing cannot invent a session or confirmation.

Confirmed status, allocation, provider-event deduplication, invoice confirmed counter and `payments.payment-confirmed.v1` commit atomically. Concurrent/repeated refresh emits and allocates once, and overpayment is rejected. Stripe test confirmations include `{provider:"stripe",simulated:true}` so billing can exclude them from production revenue. Confirmed status cannot regress. No browser redirect or client-supplied “paid” flag has authority.

## Uncertain creation and retry rules

One attempt per business/invoice remains enforced by PostgreSQL. The same invoice and connection returns/retries the existing attempt even with another client idempotency key. Changing its connection returns 409 with `checkoutId`; it never creates a second ambiguous charge. New Stripe sessions use stable `tuts-checkout-<attempt UUID>-<generation>` keys. Retries reuse the exact persisted URL-encoded request, amount and metadata. A durable 60-second lease prevents concurrent provider creation; provider requests have a 15-second overall timeout and bounded request/response sizes.

A definite rejection becomes `failed`; a network timeout, malformed response, provider conflict, or uncertain acceptance becomes `unknown`. There is no automatic retry. Staff may retry unknown creation within a conservative 23-hour window, using the same provider key and body. Stripe documents idempotency retention for at least 24 hours; after the local window, recreation is blocked as `stripe_idempotency_window_expired_manual_reconciliation_required`. Unknown outcomes never regenerate a provider key. Expired sessions and failed attempts are retained; replacing them with new sessions is not implemented in this scope.

Outbound requests target only `api.stripe.com`, require verified TLS 1.2 or newer, never follow redirects, and accept no configurable provider endpoint. Raw provider errors are redacted. Signed external webhooks, automatic reconciliation, refund, partial checkout, recurring subscriptions, stored cards, production collection and customer portal access are unavailable. Manual verified refresh is the implemented reconciliation path.

## Local simulator and environment

Sandbox connections remain `{provider:"sandbox",displayName,credentials?:{}}` with `Idempotency-Key`; credentials are synthetic. POST `/v1/checkouts/:id/sandbox-confirm` is an authenticated staff simulation action with `Idempotency-Key`. It performs no network request and marks both response/event `simulated:true`.

Set `ALLOW_SANDBOX_PAYMENTS=true`, `NODE_ENV=development` or `test`, and `PAYMENT_ENCRYPTION_KEY` to canonical base64 encoding of 32 random bytes. Sandbox refuses production/staging/unset environments. Stripe test operations also require development/test and never accept live keys or live responses; they do not need the simulator flag. Payments additionally needs `PUBLIC_APP_URL` for Stripe checkout redirects. Common environment: `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY`, optional `PORT`.

Every domain table forces tenant RLS. Issued snapshots are immutable: repeated equal events are harmless; conflicts roll back for investigation. No service-to-service source imports or cross-database queries are used.

## Checks and primary references

Run `pnpm --filter @palladium/payments typecheck`, `build`, and `test`. Database tests require `PAYMENTS_TEST_DATABASE_URL`, a non-superuser without BYPASSRLS. Stripe tests inject a synthetic provider transport and assert the attempt is committed before that transport runs. They verify test-only keys/responses, tenant-bound encryption and RLS, exact retry keys/payloads, uncertain outcomes, provider amount/metadata checks, concurrent allocation/event deduplication, connection permissions, and expiry of the safe retry window. No external provider request or charge is made by tests.

Implementation references: [Stripe Checkout creation](https://docs.stripe.com/api/checkout/sessions/create), [session retrieval](https://docs.stripe.com/api/checkout/sessions/retrieve), [account retrieval](https://docs.stripe.com/api/accounts/retrieve), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), and [currency/minor-unit rules](https://docs.stripe.com/currencies). Real external credentials have not been supplied or tested in this task.


## Cloudflare runtime

`src/worker.ts` exports this domain as an independent Worker through the shared Nest runtime; `src/main.ts` remains the Node entrypoint. The service retains its own PostgreSQL database, signed caller context, tenant RLS and event contracts. Migrations are applied during deployment, outside requests. Worker secrets and bindings are supplied by the deployment configuration.
Stripe has a fixed-origin fetch adapter with redirect rejection, bounded bodies, a 15-second deadline and conservative acceptance ambiguity. It still accepts test credentials only and rejects test mode in production. No live payment capability is enabled by deploying this adapter.
