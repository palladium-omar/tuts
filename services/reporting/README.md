# Reporting service

> Current cross-service context: [system](../../docs/architecture/system.md), [API/schema inventory](../../docs/service-inventory.md), [security/performance audit](../../docs/reviews/2026-10-10-platform-audit.md). Service descriptions below define APIs and local behavior; provider/configuration readiness is separate.

Separate NestJS/Worker service on port 4010, entitlement `reporting`, with its own
PostgreSQL database and tenant RLS. It stores rebuildable projections and scalar
first-party activity aggregates. It never imports another service's source or
joins another service's SQL. Root deployment tooling owns database roles, bindings,
queues and Worker configuration.

## API

Student reporting routes are StudentScoped and require signed server context. The business dashboard requires staff business scope. The bounded public redirect is documented below. `reporting.read`
protects summaries/history; reconciliation also requires `reporting.write`.
The server checks every requested student and its canonical alias. An empty
student scope returns no authorized data, and there is no cross-business bypass.

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `/v1/summaries` | `{studentIds:UUID[1..100],month:'YYYY-MM',timeZone:IANA,includeFinancial?:boolean}`; `{items:StudentSummary[],asOf}` |
| GET | `/v1/students/:id/summary` | month/timeZone and optional includeFinancial=`true`; `{item:StudentSummary}` |
| POST | `/v1/students/:id/reconcile` | `{month,timeZone,includeFinancial?:boolean}`; `{item:StudentSummary}` after source reconciliation |
| POST | `/v1/activity` | `{studentId,sessionId:UUID,sequence:positiveInteger,activeSeconds:integer0..30}`; `{item:{acceptedSeconds,duplicate,lastSeenAt}}` |
| GET | `/v1/students/:id/activity` | month/timeZone/limit/offset; `{items:[{date,activeSeconds,lastSeenAt}],total,limit,offset,studentId,month,timeZone,estimated:true,scope:'tuts',asOf}` |
| GET | `/v1/business-dashboard` | optional month=`YYYY-MM`; `{item:{month,timeZone,asOf,students:{total,active,leads,inactive},analytics,sources}}` |

Month accepts 2000–2200 and timeZone must be a valid IANA zone. Daily history
pagination defaults to 50, max 100. Dates are grouped by server receipt timestamp
in the selected timezone. No wall-clock timestamp is accepted from the browser.

Batch summaries use four tenant-scoped SQL statements regardless of whether the
request contains one or 100 student IDs; financial summaries use five. This
includes a shared tenant advisory read lock, one bounded recursive alias resolution, one
set aggregate for classes/homework/resources/activity, one coverage read, and the
optional financial snapshot read. Both requested IDs and resolved canonical IDs
are checked against signed student access before aggregate reads. Repeated
requested IDs are deduplicated while separate aliases retain their response
positions. Missing/partial/financial behavior is unchanged.

StudentSummary is:

```ts
{
  studentId, month, timeZone,
  bookings: { booked, completed, cancelled, noShow },
  homework: { assigned, submitted, completed, needsRevision },
  resources: { period: 'all_time', materials, submissionFiles },
  activity: { activeSeconds, lastSeenAt, estimated: true, scope: 'tuts' },
  financial?: {
    period: 'all_time', totalsByCurrency: [
      { currency, billedMinor, collectedMinor, simulatedMinor, outstandingMinor }
    ] | null,
    issuedInvoiceCount: number | null, asOf: string | null
  },
  coverage: {
    scheduling: { status, asOf, reason? },
    learning: { status, asOf, reason? },
    billing?: { status, asOf, reason? }
  },
  asOf: string | null, partial: boolean
}
```

Coverage status is missing/partial/complete/unavailable. Missing data and failed
sources with no known history return null counters. Partial counts represent
observed records, not a claim of complete history. Each source exposes its own
synchronization time and reason; failed attempts retain the prior successful
asOf. Overall asOf is the latest known synchronization/activity time. Event-only
history starts partial until an explicit source reconciliation completes.

Booked means current scheduled status. Completed, cancelled and noShow are
separate counts; elapsed scheduled time never proves attendance. Classes are
bucketed by startsAt in the selected timezone. Homework counts reflect current
status, bucketed by dueAt (or original createdAt when no due date exists). Unknown
homework dates force partial coverage. Resource counts are all-time. Materials
and uploaded submissions are distinct; a submitted assignment is not completed.

## Source reconciliation and financial policy

Reporting forwards the caller's verified Authorization to private
`SCHEDULING`, `LEARNING`, and `BILLING` service bindings through serviceFetch.
Node uses SCHEDULING_URL/LEARNING_URL/BILLING_URL. No internal broad user or source
credential is substituted. Missing features, capabilities, expired context,
invalid source responses and broken providers become explicit coverage states.
No response body, authorization token, essay, address or invoice identity is
logged or retained in projections.

Scheduling uses paginated `/v1/portal/classes?studentId&month&timeZone`.
Learning uses `/v1/portal/assignments?clientId` and
`/v1/portal/resources?clientId`; attached material/submission relationships are
replayed into resource projections. A source paginator is capped at ten 200-row
pages. Requests use 8-second source deadlines, a 25-second fetch window, an 8 MiB
response bound and a shared 12 MiB reconciliation response budget. Larger or
changing histories remain partial/unavailable, and existing projections survive.
Reconcile again after source identity synchronization; a source with fewer records
than the known inherited history cannot be marked complete. No cross-service
queries, unbounded body reads or provider calls are made.

Financial aggregation requires all of `billing.read`, `reporting.financial`, and
the `billing` entitlement. Without an explicit includeFinancial request, the
entire financial property and billing coverage are omitted. The separate Billing
student finance panel has its own policy; Reporting does not weaken it.

Financial totals come from Billing `/v1/portal/finance?studentId`, whose totals
are complete regardless of invoice pagination. They are explicitly all-time;
the month selector applies to class/homework/activity data. Report projections
retain only numeric invoice fields and opaque IDs. Business invoices without a
student ID are ignored. Confirmed collectedMinor excludes simulated allocations;
simulatedMinor is separate, and currencies are never added together. Invoice
paidMinor alone is not treated as confirmed revenue. Totals remain null until
successful reconciliation, and a newer invoice event invalidates an older
snapshot until refresh. Refunds are not currently modeled by Billing and are not
invented as zero-refund evidence.

## Activity estimate

Activity writes require role `student` in addition to reporting.write and
student scope. Guardian/tutor/browser time is not attributed to a student. A user
with an existing staff role is conservatively excluded, even if they also have a
student grant, until signed per-resource relationship policy exists. The UI should
send only while visible with recent interaction, usually every 30 seconds.
Other sites and external Google Docs activity are unavailable.

First heartbeat establishes a baseline and credits zero. Subsequent credit is
at most 30 seconds, claimed activity, and elapsed server time for both the session
and actor. Gaps longer than 60 seconds establish a new baseline. A tenant/actor
cursor prevents overlapping tabs from double counting, including different
student workspaces. New heartbeats are limited to one per actor every five
seconds (429); exact session/sequence retries return the original receipt before
rate checks. Reused sequences with different content return 409; unseen stale
sequences credit zero and retain the original session seen time.

Only server-derived actor IDs, student IDs, session/sequence idempotency, receipt
counts/times and UTC daily scalar totals are persisted. No URLs, keystrokes,
document contents, pointer streams or browser activity outside Tuts are stored.
IANA views rebucket the scalar receipt ledger by server timestamp; each credited
interval is attributed to its receipt day, so totals are estimates around day
boundaries. APIs return daily aggregates, not actor IDs or raw receipts.

## Events and identity

Required subscriptions:

- `scheduling.class-updated.v1`
- `learning.assignment-created.v1`, `learning.assignment-submitted.v1`,
  `learning.assignment-reviewed.v1`, `learning.assignment-updated.v1`
- `learning.resource-created.v1`, `learning.resource-updated.v1`
- `billing.invoice-updated.v1`
- `clients.student-merged.v1`

The shared service inbox handles delivery duplication. Each projection uses the
source's revision and stable record ID, ignoring stale lifecycle events. Legacy
assignment creation snapshots default to assigned/revision 1; late creation
metadata can fill a missing original date without regressing newer progress.
Student aliases are resolved before applying events or writes. Merge remaps
classes, homework, resources, invoice associations, session receipts and daily
history; history is retained, and financial/coverage completeness is invalidated
until a combined reconciliation. Resource-to-assignment associations survive.
Scoped callers must still have the canonical student's grant; aliases transfer
no permissions. Every table enables and forces tenant RLS.

Transactional outgoing events are `reporting.student-reconciled.v1`
`{studentId,source,month,timeZone,complete}` and `reporting.activity-recorded.v1`
`{studentId,acceptedSeconds,estimated:true,scope:'tuts'}`. Neither contains PII,
financial amounts, content, URLs or raw interaction data.

Checks: `pnpm --filter @palladium/reporting typecheck` and `build`. Runtime SQL,
source integration and event replay require environment-backed validation; no
live deployment or test run is implied by a successful build.

## Beacons attribution and exports

Official capability verification on 2026-10-10:

- [Creator traffic analytics](https://help.beacons.ai/en/articles/4698753) documents
  Beacons views and clicks. No verified public creator conversion-ingestion
  contract was found. Direct conversion transmission remains unavailable.
- [Brands API](https://help.beacons.ai/en/articles/11826369) documents key setup;
  its endpoint section says it is forthcoming. This is a separate product.
- [Brands analytics MCP](https://help.beacons.ai/en/articles/11826433) documents
  customer-authorized Amplitude, Mixpanel and PostHog connections. Tuts has no
  configured destination and sends no student or financial data to these vendors.

`GET /v1/attribution/capabilities` requires reporting.read and returns
`{item:{provider:'beacons',verifiedAt,creator:{directConversionWrite:{available:false,reason},taggedLinks:{available:true},csvExport:{available:true}},brands:{directConversionWrite:{available:false,reason},analyticsMcp:{available:false,reason}},sources:[officialSourceUrls]}}`.

Other attribution routes require owner/admin/tutor role and their indicated
capability. A tutor, including a scoped tutor, accesses only links they created.
Business-scoped owners/admins access their business's links. Parent/student roles
cannot inspect link statistics or exports. All explicitly selected student IDs
are checked against signed student scope, including canonical aliases.

| Route | Capability | Body / response |
| --- | --- | --- |
| GET `/v1/attribution/links?limit=50&offset=0` | reporting.read | `{items:Link[],total,limit,offset}`; maximum limit 100 |
| POST `/v1/attribution/links` | reporting.write | `{label,destinationUrl,source?:'beacons',campaign}` -> `{item:Link}` |
| PATCH `/v1/attribution/links/:id` | reporting.write | `{expectedRevision,enabled}` -> `{item:Link}` |
| POST `/v1/attribution/links/:id/students` | reporting.write | `{studentId}` -> `{item:{linkId,studentId,linked:true,changed,provenance:'explicit_staff_selection'}}` |
| DELETE `/v1/attribution/links/:id/students/:studentId` | reporting.write | `{item:{linkId,studentId,linked:false,changed,provenance:'explicit_staff_selection'}}` |
| POST `/v1/attribution/report` | reporting.read | `{studentIds,linkIds?:[],month,timeZone,includeFinancial?:false}` -> report below |
| POST `/v1/attribution/export.csv` | reporting.read | Same selection as report; UTF-8 CSV attachment |

`Link` is `{id,label,destinationUrl,taggedUrl,source,campaign,enabled,revision,createdAt,updatedAt,redirectUrl}`.
Names are at most 120 characters. Source/campaign use 1–80 ASCII letters,
numbers, underscores or hyphens. Destination URLs allow only HTTPS Cal.com
booking paths or the configured Tuts origin's `/` and `/portal` paths. Input
queries, fragments and credentials are rejected, including reset
and authentication URLs. UTMs are created locally; no Beacons API is called.
`PUBLIC_APP_URL` configures the Tuts allowlist; `PUBLIC_REPORTING_BASE_URL` is the
HTTPS gateway service prefix, e.g. `https://tuts.example/api/reporting`.
Only local development (`NODE_ENV` not production and `TUTS_RUNTIME` not
cloudflare) permits configured HTTP localhost/127.0.0.1 origins, including the
local gateway port. Cal.com destinations always require HTTPS without custom
ports. No arbitrary HTTP destination is accepted.

Adding an association first retrieves Clients `/v1/portal/students/:id` through
its private service binding, forwarding only the caller's verified bearer
context. The response is bounded to 1 MiB and eight seconds. The authoritative
student must exist and be a student; its canonical ID is checked again against
scope inside the mutation transaction. Removal remains possible when Clients
is unavailable. Reporting needs `CLIENTS` and local `CLIENTS_URL` for this check.
An association is an explicit staff selection; it is never proof of conversion.
Aliases remap associations without duplicating them.

The report has `{items:StudentSummary[],links,month,timeZone,asOf,provenance,capabilities}`.
Student IDs are required (1–100); link IDs are optional (0–100). Each link is
`{id,label,source,campaign,requests,requestTimeZone:'UTC',selectedStudentIds,provenance:'explicit_staff_selection',conversionMatching:{status:'unmatched',matchedConversions:null,reason}}`.
Only associations intersecting the selected authorized students are returned.
Redirect requests use UTC daily aggregates, independent of the student report's
IANA time zone. `requests` counts requests, including bots and repeated visits;
it does not count unique visitors. There is no click-to-student or
click-to-purchase matching. No signed provider conversion context exists yet,
so conversions remain unmatched. Linked student metrics and confirmed Billing
records are useful context and are not labeled campaign-caused revenue.

CSV columns are `record_type,student_id,link_id,month,time_zone,metric,value,currency,provenance,coverage,as_of`.
Metric names distinguish `bookings.completed` from `homework.completed`. Blank
values represent missing metrics; coverage remains explicit. Financial rows
require billing.read, reporting.financial and billing entitlement; they preserve
currency and real/simulated separation. Amounts are integer minor units.
Strings are quoted and formula-leading cells are escaped. Files have no-store
headers and no student names, essays, contact addresses or provider credentials.
Exports are returned to the requesting authorized user; no vendor receives them.

## Business dashboard composition

The dashboard requires `reporting.read`, Reporting entitlement and staff business
scope; student/parent roles and student-scoped tutors are denied before source
reads. It obtains exact student totals and active/lead/inactive status counts
from one Clients `/v1/clients/student-stats` request. Clients owns its single
aggregate query excluding merged records and payers. It never pages through
contacts. Clients permission/entitlement is checked before the request, and
Reporting validates safe counts and agreement between the total and statuses.

A second concurrent request reads Billing `/v1/business-analytics` only after
`canReadFinancial` and Billing entitlement checks. It forwards the original
verified Authorization through `serviceFetch`, using private CLIENTS/BILLING
bindings on Workers and CLIENTS_URL/BILLING_URL on Node. No database access or
source imports from another service are involved. Source aggregate schemas
validate safe nonnegative counts and minor units, valid currencies, unique
currency/trend buckets, timezone and month, and discard extra response fields.
Ledger measures and native invoice estimates remain separate per currency.

Every source has an eight-second deadline covering response body consumption,
including bindings that ignore abort. Each response is limited to 1 MiB, for at
most two requests and 2 MiB per dashboard. Failed, invalid or unauthorized
sources produce `status:unavailable` and a generic reason, without forwarding
upstream errors. Sources are named `clients` and `billing`. Available sources
have `status:complete`. An unavailable Clients source makes all four counts
null; unavailable financial analytics become null independently.

When month is omitted, Billing resolves the business-local current month and
timezone. If Billing is unavailable or financial access is absent, month uses
the explicit query or current UTC month and timeZone is null to mark the unknown
business timezone. Dashboard `asOf` is the composition time; Billing retains
its own aggregate `asOf`. No results are persisted or cached by the composer.

### Public redirect boundary

The sole anonymous route is GET
`/v1/public/links/:businessId/:token`; token is 32 random bytes encoded as 64
lowercase hex characters. Gateway exposes only this exact GET path with a UUID
business ID. The token deliberately publishes that selected link's destination;
it exposes no private report, association, tenant inventory or student ID.
Disabled/missing links fail closed; destinations are revalidated on each use.
Responses set `Cache-Control:no-store` and `Referrer-Policy:no-referrer`.
No cookies, IP addresses, user agents, referrer URLs or person identifiers are
stored. HEAD and recognized prefetch/preview purposes are excluded from counts.
Counting performs one aggregate update and anonymous transactional event; bot
filtering and unique visitor deduplication are unavailable. Gateway traffic
limits remain an operational responsibility. Never describe these counts as
Beacons' own measured analytics.

Attribution events: `reporting.attribution-link-created.v1 {linkId}`,
`reporting.attribution-link-updated.v1 {linkId,revision,enabled}`,
`reporting.attribution-student-linked.v1 {linkId,studentId,linked,provenance}`,
and `reporting.attribution-request-recorded.v1 {linkId,metric:'redirect_requests',timeZone:'UTC'}`.
The last event has no student or browser identity. No consumers are required.

## Static security review

Reviewed Learning and Reporting controllers, tenant SQL, private downloads,
merge aliases, revision comparisons, source HTTP reconciliation and financial
projection reads. Staff Learning create/review routes retain explicit staff
roles; portal actions check every assignment/resource student. Scoped list SQL
uses exact signed student IDs. Every financial query requires the extra financial
capabilities before reading snapshots. Out-of-order updates compare record
revisions and resolve aliases; stale invoice events do not invalidate newer
snapshots. Merge invalidates combined historical coverage and preserves resource
associations. Reporting summaries and activity-history reads now share the tenant advisory
lock, while merge/projection/activity mutations take it exclusively. Concurrent
readers can overlap; a writer cannot change aliases between identity lookup and
aggregate/coverage reads. Learning link
and submission URL validation now also rejects embedded credentials.

Review fixes also distinguish CSV booking/homework metric names (previously both
used `completed`) and preserve unavailable financial coverage in export rows.
This was static review plus typechecking/builds; no tests, adversarial requests,
SQL execution or deployment validation were performed by this agent. R2/provider
runtime behavior and bot resistance remain unverified. First activity heartbeat
credits zero; guardian/tutor activity is intentionally excluded. Private uploaded
Office/PDF files are format validated, not malware scanned.


## Read concurrency and reviewed Billing identities

`lockReports` defaults to an exclusive write lock. Summary and activity-history
paths explicitly request the shared read mode and retain it until the tenant
transaction finishes. Projection, reconciliation, merge and activity writes keep
the exclusive mode, so a response cannot mix canonical aliases with a different
projection/coverage state. Different businesses use different lock keys.

`test/read-lock.test.ts` uses real PostgreSQL connections to prove overlapping
readers, exclusive writer exclusion until both readers finish, and independent
tenant progress. `test/summary-batch.test.ts` compares all 50 card results against
the previous summary implementation, including multi-hop aliases, forced RLS,
timezones, permissions and coverage. The four/five query bound remains unchanged.

Business Dashboard accepts Billing identity coverage values
`unlinked_source_names_and_native_student_ids`,
`reviewed_work_rows_and_native_student_ids` and
`partial_reviewed_work_identities`. It preserves null student/engagement measures
when reviewed identity coverage is incomplete. Billing owns the review workflow;
Reporting neither matches names nor stores imported work associations. Run the
ordinary-role PostgreSQL suites with `node scripts/test-databases.mjs` from the
repository root.
