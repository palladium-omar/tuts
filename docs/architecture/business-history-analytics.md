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

## Manual review of historical student identity

Migration `008_history_identity.sql` adds tenant-isolated, row-level associations
owned by Billing. Importing never infers a contact from a name. Each Work tracker
row shows whether identity is unknown, ambiguous, reviewed or needs another
review. In **Monthly work**, staff use **Review identity** to choose a canonical
CRM student after checking evidence, or explicitly retain an unknown/ambiguous
result. The original name, raw cells and source bytes remain unchanged.

`PATCH billing/v1/work-log/:id/identity` accepts
`{status:'linked'|'unknown'|'ambiguous',studentId?:UUID|null,
expectedWorkRevision:positiveInteger,expectedIdentityRevision:nonnegativeInteger,
reason?:string}`. Linking requires `studentId`; other statuses forbid a nonnull
ID. Reason length is at most 500. Missing reviews have identity revision zero;
concurrent edits/reviews return 409. A successful response returns
`{item:{workId,status,studentId,revision,reason,reviewedAt}}`.

Business financial write permissions are required. Linking also requires Clients
entitlement and `clients.read`; Billing verifies the selected student through
private Clients GET `/v1/clients/:id` with the original signed authorization,
bounded to five seconds and 64 KiB. No cross-service SQL or external identity
provider is used. Unknown/ambiguous reviews make no contact lookup. Worker
`CLIENTS` binding or Node `CLIENTS_URL` must be configured; verification fails
closed when unavailable.

Work list records add `identity:{status,studentId,revision,reason,reviewedAt}`.
Read statuses also include `unreviewed` and `stale`. Any edit of a reviewed work
row invalidates that review until it is repeated against the new work revision.
Associations resolve delivered Billing student aliases, preserving the survivor
after a CRM merge. Distinct people with equal names stay distinct; spelling
variants combine only through explicit reviewed UUID associations.

Imported engagement uses reviewed canonical work-row IDs. Any unreviewed,
ambiguous or stale row in the selected activity source keeps aggregate person
metrics unknown; a month's trend student count is unknown when that month has
unresolved rows. Hours and exact currency totals remain available. The all-time
work summary continues grouping source labels and is labelled as a ledger table,
not a person-level cohort report. Billing coverage reports fully reviewed or
partial work identity status, and Reporting preserves these coverage values.

## Query contracts

- `GET work-log?month=YYYY-MM&status=unsent|pending|paid|unpaid&search=&limit=50&offset=0`
  returns `{items,total,limit,offset}`. Omitting month means all history.
- `GET work-log/summary` returns `{item:{students:[{studentName,totalHours,
  totalMinor,unsentMinor,pendingMinor,paidMinor,lastDate,currency}],
  currencies:[{currency,totalHours,totalMinor,unsentMinor,pendingMinor,paidMinor}]}}`.
  Separate currencies never sum into one amount. These are source-label ledger
  groups, not canonical person/cohort counts.
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
read coverage in one query. Including the shared advisory read lock this is four SQL statements
for 1, 50 or 100 students; finance adds one snapshot query. Forced tenant RLS and
requested plus canonical student scope checks still apply. Local PostgreSQL
regression checks compare all 50 results against the previous implementation.
Summary and activity-history readers hold shared tenant advisory locks until
their transactions finish; merge/projection/activity writers hold exclusive
locks. Readers overlap while alias, aggregate and coverage state stay coherent.
Billing analytics use one repeatable snapshot and five statements, sharing
activity/summary/trend materialization. Monthly native expected-value filtering
uses raw timestamps against timezone-derived boundaries, allowing the existing
index to filter the month without changing monetary calculations. A synthetic
4,000-class EXPLAIN check proves index eligibility with sequential scans disabled;
it is not a production latency benchmark.

Learning assignment pages batch resource metadata across the entire page. Count,
assignment rows and one deduplicated resource read use three statements for up to
200 cards with resources; an optional explicit student filter can add one
canonical lookup. Both assignment and resource scope/client checks remain in
place. Single-detail routes reuse the same checks.

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

## XLSX runtime contract

CRM and Billing keep their own ZIP structure, archive size and row/column
validation. They share only the infrastructure helper
`@palladium/service-kit/archive-inflate`, which streams one raw-deflate entry,
counts actual output before retaining it, stops on a forged declared size and
always destroys the inflater. Each caller then requires an exact entry length.
The 5 MB upload, 20 MB total expansion, XML declaration, encrypted archive,
macro and sparse-dimension restrictions remain enforced before ExcelJS loads it.

Both validators are asynchronous. Their callers must await validation before
loading the workbook. Bounded streaming avoids a Cloudflare `inflateRawSync`
`maxOutputLength` incompatibility that rejected a valid worksheet.

Generated Clients and Billing Worker configurations explicitly resolve ExcelJS's
Node entry. Its browser bundle embeds a global `process.nextTick` queue; a first
request can leave callbacks queued when the invocation ends, preventing subsequent
uploads from completing. No global timer patch or dependency-source patch is used.
Node deployments keep their ordinary module resolution. Other Workers are unchanged.

After building the affected services, run `node scripts/test-workbook-runtime.mjs`.
This starts an isolated local Workers runtime with production compatibility flags
and parser aliases, without production bindings or database access. It covers
warm repeated requests, simultaneous different workbooks, compressed entries over
64 KB, forged sizes, aggregate limits, malformed archives and a valid upload after
rejection. CI runs it after the build. An optional local file argument validates a
reported workbook and outputs only counts/row numbers; customer data stays out of
fixtures and Git.

## Guided import and interpretation

The web import is a short guided flow: upload, confirm currency, then review.
Column names and common status labels are detected by Billing; the review shows
those decisions and offers corrections without requiring every field to be filled.
Case, Unicode spacing, underscores and hyphens do not change a status's meaning.
`pending`, `Pending` and ` PENDING ` all mean awaiting payment; `Sent` and `Unpaid`
have the same default. `Unsent`/`Draft` mean not sent, and `Paid` means paid.
Explicit overrides apply to every spelling of the same normalized source label.
Conflicting case variants in an override are rejected instead of selecting one
arbitrarily. Already-staged/imported previews keep their recorded interpretation.

Currency is confirmed once per source. A selected currency applies to the whole
file unless the user chooses the file's actual currency column for mixed currency
rows. A currency-column picker is only useful when such a column exists, and is
hidden from the ordinary matching controls. Source currency symbols/codes and the
business's saved currency guide the initial suggestion; uncertain values require
confirmation. Amounts still use integer minor units on the server.

Billing preview exposes grouped observed status labels/counts and the detected
currency metadata. These are hints for the composition client; Billing remains
responsible for normalization, validation and the immutable staged preview used
by commit. The client sends only explicit matching/status corrections. Changing
a file or worksheet clears obsolete mappings, and review must refresh after
edits before commit. No tenant, permission or service ownership changes are made.

## Audit follow-up validation (10 October 2026)

The [audit](../reviews/2026-10-10-platform-audit.md) records the inspection snapshot
before these follow-up changes. Local checks use ordinary PostgreSQL roles
without superuser or BYPASSRLS privileges. Billing tests cover duplicate names,
spelling variants, review conflicts/staleness, aliases, untouched source bytes
and exact financial totals. Reporting tests cover overlapping readers, writer
exclusion and 50-result parity. Learning tests cover bounded assignment resource
queries and authorization. Full malware scanning, hosted backup/restore and
production latency require separate operational evidence.

From the repository root, `node scripts/test-databases.mjs` migrates the local
service databases and runs each of the ten domain suites. It fails on missing
test scripts, nonzero/terminated test processes and skipped tests in TAP or
Node's Unicode pretty output. The 10 October follow-up run passed 154 domain
tests, with zero failures and zero skips. This is local synthetic test evidence;
it does not assert deployment or visual browser verification of the identity
review modal.
