# Monthly arrears billing and business dashboard

## The business rule

**The first of October bills September’s completed classes.** The business chooses its IANA timezone and a positive price per completed class for each student. Cancelled and merely scheduled bookings do not enter the invoice. Pricing currently supports one active class rate/currency per student; fixed packages, hourly rates, tax/discount rules, and automatic card charging are not implemented.

The Overview dashboard shows the selected service month’s class counts and the following invoice month’s financial activity. Billed, collected, outstanding, and all-time collected are separate measures. Currencies are never summed together. Sandbox and Stripe test payments are reported separately and excluded from real collected revenue.

## Independent responsibilities

| Owner      | Owned data and API                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduling | Calendar booking projections, explicit attendance/student links, revisioned canonical class ledger                                   |
| Clients    | Student identity; frontend selects from the business’s student records                                                               |
| Billing    | Business timezone/automation settings, student rates, class projection, monthly drafts, invoices and allocations, revenue aggregates |
| Payments   | Business-owned provider credentials, hosted payment links, verified provider payment state                                           |
| Web app    | Composes dashboard and review workflows through the gateway; has no database access                                                  |

Scheduling publishes `scheduling.class-updated.v1`: `{classId,source,clientId,startsAt,endsAt,status,revision}`. `source` is internal/external. Billing consumes into its own forced-RLS projection and ignores lower revisions. External booking status is preserved separately from explicit tutor attendance; past bookings do not automatically become completed classes. Source disconnects retain historical ledger records needed for accounting.

## Reconciliation and monthly generation

1. `GET /api/scheduling/v1/class-ledger?month=YYYY-MM&timeZone=...` lists the canonical month. It backfills older sessions and transactionally publishes their snapshots.
2. `PATCH /class-ledger/:source/:id {clientId?,status}` records attendance and student association. Calendar bookings remain source records; annotations belong to Scheduling.
3. `POST /api/billing/v1/monthly/reconcile {month,timeZone?}` calls Scheduling over HTTP, forwarding verified gateway Authorization. No database is shared. The bounded complete response is applied atomically; missing/changed projected records are excluded or reported for review rather than billed from stale data.
4. `GET /student-rates`, `POST /student-rates {clientId,payerName,currency,unitPriceMinor,active?}`, and `PATCH /student-rates/:id` manage persistent rates.
5. `GET /monthly/preview?month=YYYY-MM` reports eligible students/classes, missing rates/student links, existing invoices, and late or changed billed classes requiring review.
6. `POST /monthly/generate {month}` creates **drafts** for a completed service month. One invoice per student/month and a permanent class-allocation ledger prevent duplicate billing on retries or moved classes. Line quantity is the eligible completed-class count. Amounts remain integer minor units. New late classes do not silently alter an existing invoice.
7. Invoice metadata preserves `serviceMonth`, `dueAt` (first of following month in the business timezone), and class IDs. Existing invoice review/issue APIs apply. Only issuing emits the authoritative `billing.invoice-issued.v1` amount snapshot to Payments.

Owner/admin can change settings/rates and generate drafts. Staff can read dashboard/preview and reconcile permitted class records. The combined reconciliation workflow requires `billing` and `scheduling` entitlements; contact selection additionally uses `clients`.

## Optional automation

`GET/PUT /billing-settings` exposes `{timeZone,billDay:1,autoDraft}`. Automatic drafting defaults off. When enabled, Billing’s durable worker prepares the most recent completed month once and catches up after downtime. It uses its own event projection, rates, and tenant settings; an explicit reconcile can backfill old calendar history. The worker never issues invoices, sends messages, or charges cards. Unmatched/unrated classes and later corrections remain review work.

Settings events in Billing’s own outbox provide durable tenant discovery without bypassing domain RLS. The student/month uniqueness and billed-class constraints provide retry safety. The process must be running for scheduled work; this is not a cloud scheduler deployment.

## Revenue API

`GET /api/billing/v1/dashboard?month=YYYY-MM` computes SQL aggregates over the complete business ledger, not a limited invoice-list page:

- Per currency: billed amount for invoices issued in that month; actual allocations collected in that month; test allocations separately; unpaid real amount across all issued invoices; all-time actual/test collection separately.
- Per student: completed/scheduled/cancelled counts, configured rate and estimate, and monthly invoice IDs.
- Missing student associations are reported, not guessed by name/email.

This tracks Tuts invoices and their reconciled payment allocations. It does **not** import every historical transaction from the business’s Stripe dashboard or calculate accounting profit, fees, taxes, or payouts. Payment acceptance is verified server side; a browser success redirect is never evidence of collection.
