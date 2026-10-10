# Business history, work ledger and dashboard

## Ownership and boundaries

Billing owns imported work, invoice history, original source files and monetary
aggregates. CRM owns student identity; importing work does not create contacts or
merge similar names. Reporting composes authorized aggregate endpoints. The web
shell displays a Dashboard with Overview, Work tracker, Monthly invoices and
Monthly billing tabs. The existing arrears draft workflow remains in Monthly
billing; the work/monthly views default to the current business-local month.

Business-wide history and dashboard endpoints require business access scope.
Billing data requires `billing.read` and `reporting.financial`; writes require
`billing.write`. Student and parent roles cannot access these endpoints. A future
enterprise provisioning policy can grant these capabilities at another account
level without changing service ownership. No super-admin feature is implemented.

## Source-preserving ingestion

`POST billing/v1/history-imports/preview` accepts multipart `file` (CSV/XLSX/PDF,
5 MB maximum), plus `options` JSON. Options contain `kind` (`work`, `invoices`,
`archive` or `auto`), `sheetName`, `mapping` (canonical field to source header),
`currency` (default EUR for euro-labelled sheets), `statusMap` (source label to
`unsent`, `pending`, `paid`), and `countAsClasses` (false by default).

Preview preserves every sheet/column/formula in the source archive, exposes
sheet/header choices, and produces normalized rows only from the selected data
sheet. Blank template rows and calculated summary sheets do not become work or
invoice records. Formula caches are read without executing formulas; missing
totals may be derived from validated hours multiplied by rate with a rounding
warning. Conflicting totals, missing dates/hours/rates and unknown statuses are
row errors. No name-based financial merge or inferred payment transaction.

Preview returns `{item:{kind,fileName,sheetName,sheets:[{name,headers,rowCount}],
headers,mapping,statusMap,rows:[{rowNumber,values,errors,warnings}],
summary:{valid,invalid,skipped},warnings,token}}`. Values use `date` (YYYY-MM-DD),
`studentName`, `serviceType`, `hours`, `rateMinor`, `amountMinor`, `currency`,
`status`, optional `invoiceNumber`, `paidDate` and `notes`. The token identifies a
persisted tenant-scoped staged source and the exact preview options.

`POST history-imports/commit` accepts `{token,allowPartial:false}` and an
Idempotency-Key. It commits valid normalized rows atomically (partial mode only
after explicit user review) and retains invalid/skipped/raw rows and the original
bytes. Repeated same-file/options uploads do not duplicate committed records. A changed mapping cannot import an already committed file twice.
`GET history-imports` lists sources; `GET history-imports/:id/download` downloads
the original authenticated file. PDF/archive uploads preserve bytes only;
`POST invoice-history` records reviewed invoice metadata and optional importId.
There is no fabricated OCR extraction.

Work rows retain date, name, service, fractional hours, hourly rate, total,
status and notes. Default source status mapping is Paid → paid, Sent → pending,
Pending → unsent, shown for confirmation. Each record retains source row and raw
columns. `PATCH work-log/:id` can correct fields, class classification and status.
`PATCH invoice-history/:id` updates imported invoice status/payment dates only.
Imported paid assertions are labelled historical declarations, not processor
verified payments. Native invoices/payments remain authoritative and immutable
through the history editor. Importing never sends invoices or charges clients.

## Query contracts

- `GET work-log?month=YYYY-MM&status=unsent|pending|paid|unpaid&search=&limit=50&offset=0`
  returns `{items,total,limit,offset}`. Omitting month means all history.
- `GET work-log/summary` returns `{item:{students:[{studentName,totalHours,
  totalMinor,unsentMinor,pendingMinor,paidMinor,lastDate,currency}],
  currencies:[{currency,totalHours,totalMinor,unsentMinor,pendingMinor,paidMinor}]}}`.
  Separate currencies never sum into one amount.
- `GET invoice-history` uses the same month/status/search pagination and returns
  imported invoice records plus native invoice rows labelled `origin:native`.
  Native statuses draft/issued/settled display as unsent/pending/paid.
- `GET business-analytics?month=YYYY-MM` returns `{item:{month,timeZone,asOf,
  students:{tracked,activeThisMonth,activePreviousMonth,lostFromPreviousMonth},
  engagement:{totalHours,monthHours,averageCommitmentHours,averageClassFrequency,
  churnRate},currencies:[{currency,totalRecordedRevenueMinor,
  historicalPaidMinor,verifiedCollectedMinor,pendingMinor,unsentMinor,
  expectedThisMonthMinor}],trend:[{month,hours,activeStudents,classes}],coverage}}`.
  Average commitment is recorded hours per observed active student this month;
  class frequency is confirmed classes per active class student in this month.
  Churn is the share active last month with no activity this month, labelled
  inactivity and provisional for the current incomplete month. Unknown data is
  null, not zero. Financial measures exclude simulated payments. Recorded revenue
  combines imported invoice paid declarations and verified native allocations;
  paid work rows are shown separately and never added again. Expected current
  month work is recorded work value, not a forecast. Native scheduled-class
  rate estimates are separate and may overlap imported work.

`GET reporting/v1/business-dashboard?month=YYYY-MM` composes Clients exact
student counts (`GET clients/v1/clients/student-stats`, one aggregate query) and Billing aggregates
via existing service bindings and signed authorization. Its response is
`{item:{month,timeZone,asOf,students:{total,active,leads,inactive},analytics,
sources:[{name,status,reason?}]}}`. `analytics` is null when financial permission
or source access is absent. Missing source results are independent and explicit.
Reporting does not query Billing/Clients databases or duplicate raw file storage.

## Loading performance

Render page structure immediately. Fetch aggregate sections concurrently, never
fetch every contact page to calculate a count. Keep the last successful result
visible during refresh with an Updating label, cancel superseded filtered list
requests and debounce typing. API caches are short-lived, memory-only, scoped to
the mounted authenticated business API, reset on mutations/context changes,
and never reused as proof of authorization. Requests have bounded timeouts.
Reporting student summaries resolve aliases for the whole requested page in one
recursive query, aggregate classes/homework/resources/activity together, and
read coverage in one query. Including the merge lock this is four SQL statements
for 1, 50 or 100 students; finance adds one snapshot query. Forced tenant RLS and
requested plus canonical student scope checks still apply. Local PostgreSQL
regression checks compare all 50 results against the previous implementation.
Calendar pages render as they arrive within a bounded date range; changing the
range cancels obsolete requests, while refresh preserves the current calendar.

Identical reads share one pending request; canceling a subscriber does not cancel
another screen's shared read. Explicit refresh bypasses the recent-read cache.

Backend Workers use `placement.region` from the deployment manifest, currently
`aws:eu-west-2` alongside Neon in London. The public gateway and static assets
remain at the edge. This reduces repeated transaction round trips without
migrating databases or combining services. Each gateway response exposes safe
`Server-Timing` durations for identity, service and total gateway work; structured
logs record these durations alongside the request reference. No tokens or raw
request data are included. Neon may still need to wake after inactivity.

## Deployment

Keep PostgreSQL/Cloudflare service separation and current private bindings.
Billing source archives use tenant-isolated PostgreSQL bytea with strict size
bounds, avoiding a new publicly accessible bucket. Add a Billing migration and
deploy existing backend Workers with database-region placement and the gateway
after checks. No new paid Cloudflare resources are introduced. Preserve existing secrets,
bindings, routes and unrelated working-tree changes. Real workbook rows are
never committed or imported to production as part of implementation testing.
