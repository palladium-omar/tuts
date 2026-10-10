# Business history dashboard and loading review

## Scope

Separate Billing source archive, work ledger, imported invoice history and financial
aggregates; Reporting composes authorized service aggregates. Existing deployment,
service databases and capabilities are preserved. Architecture was documented in
`docs/architecture/business-history-analytics.md` before implementation.

## Checks completed

- Original spreadsheet inspected read-only. Primary work sheet has 87 entries:
  84 can be normalized, 3 require review. Calculated summary sheet is preserved,
  not imported as additional work. Source rows are never uploaded to production
  during implementation.
- Synthetic CSV uploads through authenticated local gateway: preview, commit,
  idempotent retry, source archival, monthly/unpaid filtering, total hours,
  paid invoice revenue, and separate paid work declarations verified.
- Real PostgreSQL Billing regression: forced tenant RLS, permission boundaries,
  opaque actor IDs, transactions, concurrent retries, duplicate source guards,
  currency precision and history aggregation. Writes rolled back.
- Real PostgreSQL Reporting comparison: all results for 50 students equal the
  previous implementation; summary query count remains four inside the tenant
  transaction, five including finance, independent of 1/50/100 requested IDs.
  Requested/canonical identity authorization, aliases, cycles and tenant isolation
  checked. Writes rolled back.
- Automated affected suites: web20, Billing21, Reporting18, gateway20,
  deployment10, service-kit19, Clients6. No skipped database checks.
- All backend service builds, web typecheck and service import boundaries pass.
- Browser walkthrough in synthetic local tutor workspace: CRM search, student
  cards and progress, immediate assignment modal with paged recipient search,
  dashboard return navigation, work aggregate/monthly view, fractional-hours edit
  with recalculated amount, current-month invoices, all-month paid filter.
  Browser upload chooser was unavailable; multipart upload was exercised through
  the authenticated gateway instead. No real client rows used as browser fixtures.
- Browser walkthrough caught a renamed dashboard navigation guard preventing
  return from another feature; corrected and regression tested before release.

## Performance changes

Replace sequential per-student summary queries and whole-contact-list fetches.
Use bounded searchable lists, concurrent aggregate sources, short-lived private
read deduplication, cache invalidation on writes and API-context changes, stale
request cancellation and explicit deadlines. Keep last successful rows visible
on refresh; calendar pages render as they arrive. Database-backed Workers move
near existing London Neon databases; gateway stays at the edge. Safe request
references and gateway/identity/service timing are available for future diagnosis.
No measured production speed percentage is claimed. Database wake-up after idle
can still affect an initial request.

## Financial meaning

Work ledger status is a declaration, not a processor-confirmed payment. Imported
invoice paid declarations and real native payment allocations contribute to
recorded revenue; work totals are separate. Simulated payments never count as
collected. Monthly logged work value is not a future revenue forecast. Native
class estimates are separate because imported work may overlap them. Class
frequency requires explicitly classifying work rows as classes. Inactivity is
provisional for the current month; unknown coverage is not rendered as zero.

## Release

Hosted additive Billing migration `007_business_history.sql` applied with an
ordinary isolated database role and verified TLS. All three new tables enforce
forced row-level security. Existing source records and payments are untouched.
Live mail switches were read and preserved. Deployment verification receipt is
stored privately alongside the release build and matched asset hashes.
