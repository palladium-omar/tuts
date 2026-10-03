# Payments service

Independent NestJS process (4006), dedicated PostgreSQL database, `payments` entitlement. Gateway prefix `/api/payments`; service routes below use `/v1`.

- `GET /v1/providers`: provider availability/capabilities. Stripe Connect, PayPal Commerce Platform and bank integrations report unavailable and reject creation with 422. No live checkout, onboarding, automatic bank reconciliation, refund or external webhook verification is implemented.
- `GET /v1/connections`; `POST /v1/connections` (owner/admin): `{provider:'sandbox',displayName,credentials?:{}}` plus `Idempotency-Key`. Credentials are AES-256-GCM encrypted at rest; responses never include them.
- `GET /v1/checkouts`; `GET /v1/checkouts/:id`.
- `POST /v1/checkouts`: `{invoiceId,connectionId}` plus `Idempotency-Key`. No amount/currency is accepted from the browser. A missing issued-invoice event projection returns 409 `invoice_snapshot_unavailable`; retry after broker processing.
- `POST /v1/checkouts/:id/sandbox-confirm`: staff-only simulated confirmation plus `Idempotency-Key`. This is an authenticated simulation command, not a provider webhook. Response and event explicitly mark `simulated:true`.

Responses use `{items:[...]}` for lists/catalogue and `{item:...}` for objects/writes.

All endpoints require authenticated staff and the service entitlement; connections require owner/admin to create. Every business table forces RLS. Mutation keys are scoped by business/operation and reject changed input. One full-total checkout per invoice is allowed. A second key cannot create another attempt: 409 `invoice_checkout_exists` includes `checkoutId`; use that existing attempt. Partial checkout, replacing a pending connection, retries with new charges, cancel/refund, and customer self-checkout are not supported.

Enable sandbox explicitly with `ALLOW_SANDBOX_PAYMENTS=true`, set `NODE_ENV=development` for local operation, and supply `PAYMENT_ENCRYPTION_KEY` as canonical base64 encoding of 32 random bytes. Only development/test environments accept sandbox; unset, staging and production environments reject it even if the flag is true. Never copy development encryption keys into production; key rotation is not implemented.

Issued snapshots are immutable. Repeated issued events with the same amount/currency are harmless; changed snapshots roll back for investigation. Attempt, simulated provider event, monotonic confirmation, invoice projection counter and outgoing event commit together. Duplicate confirmations return the same attempt without another outgoing event. Missing callbacks leave the checkout pending until staff explicitly confirm; querying an attempt never invents confirmation. Out-of-order external notifications are rejected because external webhook adapters are unavailable. Confirmed status cannot regress to pending. Real integrations will need signed raw-body webhook verification and unknown-outcome reconciliation before enablement.

`pnpm --filter @palladium/payments test` runs provider, encryption, sandbox gate and transition invariants. Repository integration checks exercise persisted sandbox collection, duplicate delivery, tenant isolation and role boundaries.
