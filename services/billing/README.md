# Billing service

Independent NestJS process (4005), dedicated PostgreSQL database, `billing` entitlement. Gateway prefix `/api/billing`; service prefix `/v1/invoices`. Runtime authenticates business membership and staff roles. Clients/parents have no financial endpoint access in this release.

- `POST /v1/invoices`: `{payerName,clientId?,currency,items:[{description,quantity,unitPriceMinor}]}`.
- `GET /v1/invoices`: latest 200 invoices; `GET /v1/invoices/:id`.
- `POST /v1/invoices/:id/issue`: changes draft to issued and emits an immutable amount/currency snapshot transactionally.

Responses use `{items:[...]}` for lists and `{item:...}` for objects/writes.

All writes require `Idempotency-Key` (1–200 printable ASCII characters). Keys are scoped by business and operation; issue keys bind the invoice ID. Identical retries return the original response. Reusing a key for different input returns 409. A later get returns current state; a replayed create response remains its original draft snapshot.

Money uses integer minor units, exact BigInt calculation, and a safe-integer total ceiling. Zero-total invoices are unsupported. Currency is an uppercase three-letter code; no decimal-place conversion occurs. `clientId` is a reference supplied by staff and is not validated against a different service's database. Invoice edits, cancellation, refund, taxes, discounts, pagination beyond the latest 200, and automatic session billing are not implemented.

`payments.payment-confirmed.v1` allocations run in the runtime inbox transaction, independently of current billing entitlement. A payment ID has one immutable allocation per business. Currency mismatch, draft/unknown invoice, payment identity mismatch, and overpayment roll back and enter the broker retry/dead-letter path. The invoice is settled only when allocations exactly match its total. Unknown references are never acknowledged as settled; retry/replay after fixing the reference is required. Forced RLS applies to every service table.

`pnpm --filter @palladium/billing test` runs invariant tests. The repository integration test exercises persisted service behavior, tenant and role restrictions, event delivery and retry behavior. Production must monitor dead letters and service outbox backlog.
