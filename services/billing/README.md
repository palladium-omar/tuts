# Billing service

> Current cross-service context: [system](../../docs/architecture/system.md), [API/schema inventory](../../docs/service-inventory.md), [security/performance audit](../../docs/reviews/2026-10-10-platform-audit.md). Service descriptions below define APIs and local behavior; provider/configuration readiness is separate.

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


## Scoped student financial history

`GET /v1/portal/finance?studentId=<uuid>&limit=50&offset=0` is staff-only (`owner`, `admin`, `tutor`) and requires the Billing entitlement, `billing.read`, and access to that student. Students/guardians cannot read it, despite the historical `/portal/finance` path name. It returns issued invoices, paginated recorded payments, counts and complete totals separated by currency. Drafts and payment credentials are excluded. Simulated allocations are labeled and never counted as real collections. Totals are all-time; the student report month does not redefine their period.

Client merge events install a local alias, preserving historical invoice IDs and seller/payer snapshots. Alias rates are retained but disabled for staff review; the survivor's existing rate is preserved. Monthly drafting recognizes earlier invoices under the merged identity and retains billed-class review flags. A merge never silently changes a price or combines issued invoices.

`billing.invoice-updated.v1` publishes revisioned invoice state after issue/payment allocation for Reporting. It contains IDs and monetary totals, without payer contact details. Reporting uses a scoped Billing reconciliation before showing real collection totals, because invoice paid amounts can contain explicitly simulated payments.

Attendance `no_show` is accepted in the billing projection and is not billable under the current completed-classes policy. Monthly arrears remain unchanged: October 1 drafts September's completed classes.

## Source-preserving business history

Business history endpoints require business access scope, staff role, `billing.read`
and `reporting.financial`; mutations also require `billing.write`. Student/parent
roles and tutors restricted to student scope are rejected before reading data.

- `POST /v1/history-imports/preview`: multipart `file` and `options` JSON. Files
  are CSV, XLSX or PDF, at most 5 MB. Options include `kind`, `sheetName`, `mapping`,
  `currency`, `statusMap`, and `countAsClasses` (false by default). Canonical mapping
  keys are `date`, `studentName`, `serviceType`, `hours`, `rateMinor`, `amountMinor`,
  `currency`, `status`, `invoiceNumber`, `paidDate`, `notes`. Empty mapping values
  clear inferred fields; empty status mappings explicitly require row review.
- `POST /v1/history-imports/commit`: `{token,allowPartial:false}` and
  `Idempotency-Key`. A tenant-scoped persisted preview fixes the exact source and
  options. Errors block commit until corrected or partial mode is explicitly
  selected. A same-file/options retry returns the original result; a previously
  committed file with changed options cannot create another ledger copy.
- `GET /v1/history-imports?limit=50&offset=0` lists archived sources including
  `status:staged|committed`, summary, and private download path.
  `GET /v1/history-imports/:id/download` returns the original authenticated bytes.
- `GET /v1/work-log` and `GET /v1/invoice-history` accept `month=YYYY-MM`,
  `status=unsent|pending|paid|unpaid`, `search`, `limit` and `offset`. `unpaid`
  includes unsent and pending; absent month means all history. Counts cover the
  entire matching tenant dataset. Invoice history unions native and imported
  rows with `origin` and payment evidence. Native `paidMinor` is real allocations;
  `simulatedMinor` is returned separately, even when a test invoice is settled.
- `GET /v1/work-log/summary` returns exact student-name and currency summaries;
  currencies are never combined and names do not create or merge CRM contacts.
- `PATCH /v1/work-log/:id` corrects ledger fields, `countAsClasses`, status and
  notes; optional `revision` rejects stale edits. Corrected hours/rates recompute
  the amount. `PATCH /v1/invoice-history/:id` permits only imported status,
  paid-date and revision corrections; native invoices remain immutable here.
- `POST /v1/invoice-history` records reviewed metadata `{date,studentName,
  serviceType?,amountMinor,currency,status,paidDate?,invoiceNumber?,notes?,
  importId?}` with `Idempotency-Key`. Import IDs may reference a PDF archive.
  Duplicate invoice numbers (including native IDs) require review. Unnumbered
  records cannot be automatically reconciled to a native invoice.

PostgreSQL stores original bytes, original raw cells/formulas from every sheet,
options, normalized preview errors/warnings and accepted ledger rows separately.
Parsing does not execute formulas. Formula caches are read; missing work totals
may be derived from valid hours and rate with a rounding warning. The parser
limits sheets, expanded ZIP size, rows, columns and cells before loading workbooks.
Calculated sheets and template-only lines remain archived. PDFs are archive-only;
there is no OCR extraction. CSV monetary values are major units by default, with
currency-specific decimal exponents; headers containing `minor` indicate exact
minor units. Fractional hours have at most six decimal places. All financial
arithmetic uses exact integer rounding and rejects unsafe totals.

`GET /v1/business-analytics?month=YYYY-MM` defaults to the business-local current
month. The aggregate separates work ledger amounts from invoice revenues. Recorded
revenue equals real native allocations plus imported invoice paid declarations;
simulated payments and paid work assertions are excluded. Expected monthly work
value and native class estimates are separate. When work history exists, hours,
trends and observed student counts use that ledger; otherwise they use completed
native classes. Sources cannot be combined safely without reviewed identity links.
Missing identity/classification data produces null measures with coverage notes.
Churn describes inactivity relative to the previous month and remains provisional
until the selected month ends. Importing history never issues invoices, charges
clients, sends messages, or creates payment transactions.

`BILLING_TEST_DATABASE_URL` enables rollback-only synthetic PostgreSQL tests for
source bytes/raw retention, tenant boundaries, staged tokens, partial review,
retries, duplicate prevention, edits and exact multicurrency aggregates. No real
customer workbook belongs in fixtures or production implementation checks.
