# Billing service

Independent NestJS process (4005), dedicated PostgreSQL database, `billing` entitlement. Gateway prefix `/api/billing`; service prefix `/v1/invoices`. Runtime authenticates business membership and staff roles. Clients/parents have no financial endpoint access in this release.

- `POST /v1/invoices`: `{payerName,clientId?,currency,items:[{description,quantity,unitPriceMinor}]}`.
- `GET /v1/invoices`: latest 200 invoices; `GET /v1/invoices/:id`.
- `POST /v1/invoices/:id/issue`: changes draft to issued, snapshots the latest business seller identity, and emits an immutable amount/currency snapshot transactionally.

Invoices include `sellerSnapshot:{businessId,name,profile,branding}`. Draft creation snapshots the locally projected seller if available; issuing refreshes that snapshot from the current projection. An absent projection returns a retryable 409 explaining that business settings must be saved and identity synced. Older issued invoices may have `sellerSnapshot:null`. A database trigger prevents seller changes after issue.

Responses use `{items:[...]}` for lists and `{item:...}` for objects/writes.

All writes require `Idempotency-Key` (1–200 printable ASCII characters). Keys are scoped by business and operation; issue keys bind the invoice ID. Identical retries return the original response. Reusing a key for different input returns 409. A later get returns current state; a replayed create response remains its original draft snapshot.

Money uses integer minor units, exact BigInt calculation, and a safe-integer total ceiling. Zero-total invoices are unsupported. Currency is an uppercase three-letter code; no decimal-place conversion occurs. `clientId` is a reference supplied by staff and is not validated against a different service's database. Invoice edits, cancellation, refund, taxes, discounts, pagination beyond the latest 200, and automatic session billing are not implemented.

`payments.payment-confirmed.v1` allocations run in the runtime inbox transaction, independently of current billing entitlement. A payment ID has one immutable allocation per business. Currency mismatch, draft/unknown invoice, payment identity mismatch, and overpayment roll back and enter the broker retry/dead-letter path. The invoice is settled only when allocations exactly match its total. Unknown references are never acknowledged as settled; retry/replay after fixing the reference is required. Forced RLS applies to every service table.

`pnpm --filter @palladium/billing test` runs invariant tests. The repository integration test exercises persisted service behavior, tenant and role restrictions, event delivery and retry behavior. Production must monitor dead letters and service outbox backlog.

`platform.business-profile-updated.v1` maintains the billing-owned `business_seller_profiles` projection under forced tenant RLS. It validates platform producer and business identity, deduplicates through the inbox, and updates only for a higher per-business revision. The shared durable broker binding preserves events while billing is offline. Branding, including a small inline logo, travels with the seller snapshot so issued invoices do not depend on a later platform fetch.

## Monthly arrears billing and dashboard

Monthly billing creates draft invoices for completed classes in the previous
service month. October 1 drafts therefore bill September classes. Attendance is
never inferred from a booking's date: provider bookings that remain scheduled
must be explicitly reconciled in the scheduling class ledger. Scheduling publishes
revisioned class snapshots; billing keeps its own RLS projection and accesses no
other service's database. Reordered snapshots cannot overwrite a newer revision.

| Method | Path                                | Shape                                                                                                |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/v1/billing-settings`              | `{item:{timeZone,billDay:1,autoDraft,automaticSupported:true,lastDraftMonth}}`                       |
| PUT    | `/v1/billing-settings`              | Owner/admin; `{timeZone,autoDraft,billDay?:1}`                                                       |
| GET    | `/v1/student-rates`                 | `{items:[{id,clientId,payerName,currency,unitPriceMinor,active,createdAt,updatedAt}]}`               |
| POST   | `/v1/student-rates`                 | Owner/admin; `{clientId,payerName,currency,unitPriceMinor,active?:true}`                             |
| PATCH  | `/v1/student-rates/:id`             | Owner/admin; partial payerName/currency/unitPriceMinor/active; clientId immutable                    |
| POST   | `/v1/monthly/reconcile`             | Staff; `{month:'YYYY-MM',timeZone?}`; `{item:{month,timeZone,reconciledCount}}`                      |
| GET    | `/v1/monthly/preview?month=YYYY-MM` | `{item:{month,timeZone,students,unrated,unmatched,requiresReview,automaticSupported:true}}`          |
| POST   | `/v1/monthly/generate`              | Owner/admin; `{month}`; `{item:{month,created,existing,requiresReview,unratedCount,unmatchedCount}}` |
| GET    | `/v1/dashboard?month=YYYY-MM`       | `{item:{month,timeZone,currencies,students,unmatchedCount}}`                                         |

Each student has one rate per business. Prices are positive integer minor units,
and currency is a three-letter uppercase code. Payer names are manually entered
snapshots, as with ordinary invoices. Student IDs are supplied by the CRM; billing
does not import the CRM's database or assume a name from an email address.

Reconcile calls `SCHEDULING_URL/v1/class-ledger` over HTTP with the caller's verified
gateway authorization. An incomplete/unavailable response fails without applying
partial results. Complete snapshots mark older absent projected rows unavailable, preventing stale moved classes from billing in the wrong month; newer event revisions restore their authoritative state. The ledger returns up to 10,000 classes for an IANA time zone and
calendar month; a larger month is rejected explicitly. Start time in that time zone
defines service-month membership, including DST and UTC/local month boundaries.
Use reconciliation to backfill existing historical classes before the first draft.

Preview student rows contain clientId, payerName, currency, unitPriceMinor,
completedCount, classIds (source-prefixed IDs eligible for a new draft), totalMinor,
existingInvoiceId, existingInvoiceTotalMinor, billableCount and lateClassIds. Unmatched completed classes have no student;
unrated completed classes have no active rate. Both are reported and excluded.
Generation rejects current/future service months and serializes with projection
updates. A unique student/month invoice and unique billed class identity prevent
retry duplicates or charging one class again after moving its date/student.
Monthly invoices expose serviceMonth, dueAt (local midnight of the following
month's first day) and classIds. Existing drafts remain historical snapshots:
new late classes and subsequent changes to billed classes require review and
never silently rewrite or duplicate the original invoice.

Settings default to UTC and autoDraft=false. With autoDraft enabled, the billing
process checks every minute and creates the most recent completed month's drafts from its durable class projection. Saved settings events in this
service's durable outbox provide the tenant catalogue; no user token or active
browser is required. It starts preparing drafts from the first business-local day and catches up after a restart or late enablement. A lastDraftMonth marker and invoice uniqueness make worker
retries safe. After an outage, it catches up the most recent completed service month; older missed months can be generated manually. AutoDraft does not issue invoices, create payment
checkouts, charge accounts or send messages. Unknown students/rates remain visible
in preview for staff review. Configure the business time zone and backfill the
ledger before enabling automation.

Dashboard currency rows contain currency, billedMinor (issuedAt within selected
month), collectedMinor (real payment allocation createdAt within selected month),
sandboxCollectedMinor (all simulated allocations for that month), outstandingMinor
(all issued totals less real allocations), allTimeCollectedMinor and
allTimeSandboxCollectedMinor. Currencies are never combined. Sandbox and Stripe
simulated payments are excluded from real revenue, even if their invoice is marked
settled in the test workflow. Draft invoices are excluded from billed/outstanding.
SQL aggregates cover the full tenant dataset and do not use the invoice list's
200-item limit. Student rows include all students with monthly classes or rates,
including unrated students: clientId, payerName, currency, unitPriceMinor,
completedCount, scheduledCount, cancelledCount, estimatedMinor and invoiceIds.

Checks: service test/build commands. With `BILLING_TEST_DATABASE_URL`, synthetic
fixtures verify completed-only billing, local month boundaries, retries, late
classes, projection ordering, tenant isolation, real/test revenue and automatic
first-day drafting. Fixtures are rolled back.


## Cloudflare runtime

`src/worker.ts` exports this domain as an independent Worker through the shared Nest runtime; `src/main.ts` remains the Node entrypoint. The service retains its own PostgreSQL database, signed caller context, tenant RLS and event contracts. Migrations are applied during deployment, outside requests. Worker secrets and bindings are supplied by the deployment configuration.
Billing reconciliation uses the `SCHEDULING` service binding and forwards signed authorization with a 30-second deadline. The private runtime tick calls `MonthlyService.runAutomatic()`. Worker startup creates no polling timers; the central 15-minute cron drives automatic draft checks. Manual reconciliation and invoice actions remain request driven.
