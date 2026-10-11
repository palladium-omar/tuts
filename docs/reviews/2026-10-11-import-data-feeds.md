# Imported student identities and business data feeds — 11 October 2026

## Scope and release state

This review records the source-import, Clients identity, Billing aggregate,
student work-history and browser cache repair described in the
[business data-feed map](../architecture/business-data-feeds.md). The initial
architecture was recorded before service implementation. The existing ten
services, separate PostgreSQL databases and Cloudflare Pages/Workers/Hyperdrive
deployment remain the architecture.

**Published on 11 October 2026** at
[tuts.palladiumscholars.com](https://tuts.palladiumscholars.com). The full service
deployment and final Web publication commands completed successfully. Local
browser evidence establishes import/student review, selected-month Dashboard,
the tracker Work view and reopening completed matching as described below.
The hosted source was repaired, and six private-binding read probes returned
HTTP 200 through the actual Workers and Hyperdrive databases. Local browser,
hosted API and public static-asset evidence remain distinct.
Private workbook names, contact details, customer content, credentials and
production identifiers are excluded from this review.

## Verified causes

### Work import did not create CRM identities

The previous Billing import committed original bytes and normalized work rows to
Billing-owned tables. It never called Clients to create profiles or attach
canonical student IDs. The work table's student-name column was a source label,
not a CRM identity. Seeing work rows therefore did not establish that CRM students
or student associations existed.

Missing email was not the cause: Clients supports name-only student profiles.
The import needs an explicit identity-review step because equal names can refer
to different people and spelling variants can refer to the same person. Staff
must choose creation, an existing canonical student, or later review.

### Billing aggregate failed before reading measures

`Database.withTenant` first began a transaction and selected transaction-local
tenant context. The previous `HistoryAnalyticsService` then executed
`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`. PostgreSQL rejected changing
isolation after the first query with SQLSTATE `25001`.

Reporting's Dashboard independently reads Clients student statistics and Billing
business analytics. The Billing failure made its hours, money, trend and timezone
aggregate unavailable together while Clients counts could still succeed. Work
history used a different Billing read path, explaining why the ledger could
remain visible while the Dashboard aggregate failed. This was not a per-student
Dashboard request loop or a wait for an event projection.

Several Billing database tests had proxy code returning an empty result instead
of executing the isolation statement. That suppression hid the production
transaction sequence. The suppression has been removed, and regression tests
now exercise the actual tenant helper with ordinary PostgreSQL roles.

## Implemented changes

| Area | Implemented behavior |
| --- | --- |
| New and existing source review | Work imports open a student review step when the caller has Clients management access. Previously committed work files expose Match students in Original files. Staff can select row subsets, explicitly confirm the review or leave groups for later. |
| Matching and name-only students | Billing supplies owned work IDs, labels and revisions. Clients previews bounded exact normalized-name candidates; ambiguous names require selection. Explicit creation produces a name-only student at Clients' default lead stage, without contact opt-ins or portal invitations. |
| Recoverable writes | Clients stores durable import/group decisions and canonical IDs. Preview retains the saved create/link action. Billing closes its initial validation transaction before Clients HTTP, then locks and revalidates rows before atomically recording associations, events and completed receipts. |
| Retry and correction | A contact-side commit can be recovered without duplicate profiles. Exact completed Billing retries add no associations, revisions or events. Changed work/identity revisions conflict, and a concurrent correction rejects the whole Billing batch. Subsequent identity correction uses the existing manual row-review route. |
| Source and finance preservation | Association repair preserves original bytes, row names, dates, hours, rates, amounts, statuses and classification. It creates no work duplicates, native classes, invoices or verified payment records. |
| Aggregate transaction | An enumerated Database isolation option sets repeatable read in BEGIN before tenant context. Four domain aggregate statements share one snapshot. Exact count/money/numeric range validation and source timing diagnostics remain in place. |
| Staff student work history | A separate Billing endpoint returns only current reviewed canonical work associations, paginated rows and currency-separated monthly/all-time totals. It verifies the requested student through Clients' compact identity endpoint and checks requested/canonical/alias access. Raw workbook fields and unrelated contact data are excluded. |
| Tracker presentation | The student tracker includes a separate Work tab with month/all-history controls, pagination and source-declaration labels. Native sessions, invoices and verified payments retain their existing meanings. |
| Browser cache | Reporting POST summary reads deduplicate by request body/context; Billing/Clients writes invalidate Reporting reads. Billing student resolution also invalidates Clients lists. Dashboard subscriptions trigger fresh aggregate reads, and request generations prevent stale reads from repopulating active list state. |
| Reopened recovery counts | Profiles already created by an interrupted Clients step count as existing in the review UI. Success wording avoids claiming that a recovered profile was newly created by the retry; a Web regression covers the count. |
| Full response deadlines | Import resolution and manual identity verification own their request AbortControllers and body readers. Deadline expiry aborts and cancels stalled bodies, late responses and rejected response bodies are cancelled, and reader locks are released. Time limits remain eight seconds for import resolution and five seconds for manual verification. |

The compact Clients identity contract is `GET /v1/clients/:id/identity` →
`{item:{id,kind}}`. It returns no contact fields. Staff roles and Clients read
permission are mandatory; scoped tutors need grants for requested and canonical
IDs. Billing work history additionally requires Billing/Clients entitlements and
business financial permission. Student/parent accounts cannot read these staff
financial routes or manage imported identities.

Detailed shapes, row-set key derivation, bounds and recovery semantics are in the
[architecture](../architecture/business-data-feeds.md#implemented-bounded-http-contracts),
[Billing README](../../services/billing/README.md#students-from-committed-work-sources)
and [Clients README](../../services/clients/README.md).

## Local evidence

The coordinating agent's local browser import and identity-review walkthrough
reconciled the following aggregate values. These figures identify no private
student or source file.

| Measure | Verified result |
| --- | --- |
| Imported work rows | 84 |
| Newly created student profiles | 25 |
| Existing canonical student selected | 1 |
| CRM students after review | 26 |
| Recorded hours before/after identity review | 85.5, unchanged |
| Recorded value before/after identity review | 647400 integer minor units, unchanged |

The local Dashboard showed 26 CRM students and 26 students tracked by reviewed
work. Its month controls produced the following recorded-work figures; these
values are ledger declarations, not verified payment collections.

| Selected month | Recorded hours | Active students with work | Recorded monthly work value |
| --- | --- | --- | --- |
| October 2026 | 14.5 | 11 | €965 |
| September 2026 | 43 | 17 | €3824 |

September displayed average commitment of 2.53 hours and inactivity of 22.22%.
One local Dashboard request returned HTTP 200 with a 42.576 ms timing value
observed in its browser Network response headers. This is a single local request
observation; it does not measure hosted performance or establish a latency
distribution.

The tracker Work tab for the selected existing student showed seven September
rows, with all-history totals of 7 hours and 49000 integer minor units. Selecting
October correctly showed zero monthly work and no rows, while preserving the
all-history totals. This verifies that an empty selected month is distinct from
an unavailable source and that per-student Work history reads reviewed
associations rather than native class or payment records.

Reopening Original files → Match students reported all rows linked, zero new
profiles and zero records to link. Finishing the review added no further import
or work rows. The compact matching layout and styling were inspected in the
local browser. These checks establish the exercised local UI state, without
claiming coverage of every viewport or accessibility interaction.

Ordinary-role PostgreSQL tests cover forced tenant RLS, permissions, payload
bounds, source ownership, missing-email creation, ambiguous names, canonical
aliases, exact completed replay, recovery after Clients commits, malformed source
responses, concurrent revision changes and unchanged financial/source records.
Analytics tests execute the real transaction helper without isolation suppression
and retain the four-domain-query performance assertion. Web regression tests
cover ambiguous suggestions, saved action on reopening, selected-row key parity,
Reporting summary deduplication and mutation invalidation.

The local browser figures above establish the exercised import, review,
Dashboard month changes, tracker Work tab and completed-review reopening.
The hosted evidence below covers the repaired hosted source and service reads,
without treating the local walkthrough as a hosted browser walkthrough.

## Hosted source repair and recovery

The already imported hosted source contained 84 work rows in 26 reviewed name
groups. Its explicit decisions created 25 name-only student profiles and reused
one existing canonical student. Canonical CRM students increased from 15 to 40.
The new profiles are lead-stage students with no email/phone inferred and
communication opt-ins disabled.

The first attempt committed Clients' 25 profiles and all 26 durable mappings
before Billing associations were applied. A retained recovery snapshot showed
zero Billing identity rows/receipts at that point. The interruption's likely
service-deadline cause is an inference recorded in the recovery evidence; the
original exception category was not retained.

Recovery reused those mappings in seven successful batches: six of four groups
and a final batch of two. It linked all 84 work rows without creating duplicate
profiles. Creation-origin counts returned by the mapping contract describe the
original decisions, not new profiles created by the resumed operation. Original
source and work-row hashes were preserved, and totals remained 85.5 hours and
647400 EUR minor units (€6474). The repair did not reimport the source, infer
emails, create native invoices/payments or send invitations/messages.

## Hosted read and publication evidence

Six read-only signed-context probes through private service bindings and
Hyperdrive returned upstream HTTP 200. The recorded check time was
**15:25:15 UTC on 11 October 2026**. These probes exercised the actual hosted
Clients, Billing and Reporting services, rather than mock aggregates.

| Hosted read | Verified result |
| --- | --- |
| Clients student statistics | 40 canonical students: 2 active, 38 leads, 0 inactive |
| October Billing analytics | 84 source rows, 85.5 all-time hours, 26 tracked students; 14.5 monthly hours, 11 active students, 96500 EUR monthly work minor units |
| October Reporting Dashboard | Clients and Billing sources both complete |
| September Billing analytics | 26 tracked students; 43 monthly hours, 17 active students, 382400 EUR monthly work minor units |
| September Reporting Dashboard | Clients and Billing sources both complete |
| Selected hosted student's work history | October total 2 rows; limit 1 returned 1 row. All-time 10 hours / 70000 minor units; October 3 hours / 21000 minor units |

Both months retained the complete source aggregate of 84 rows, 85.5 hours and
647400 EUR minor units. The selected hosted student is separate from the local browser
fixture described above; no student identity is published here.

The six proxy round trips ranged from 0.992 to 2.726 seconds in one bounded
probe batch. Those values include the proxy/service path and are not a hosted
browser performance distribution or an end-to-end interaction benchmark.

Both public page endpoints returned HTTP 200. Their HTML and all 19 checked
assets matched the final static export. Eleven protected routes returned HTTP
401 to anonymous requests. The full deployment and final Web publication
commands exited successfully. This establishes publication, static asset
consistency and the checked anonymous boundary; it does not substitute for
authenticated hosted browser testing of every role or interaction.

Final checks passed: **251/251 database-backed tests with zero skips**,
**87/87 Web tests**, and final build/typecheck. Billing's deadline regressions
also confirm cancellation of stalled bodies, released locks, late-response
cleanup and unchanged status meanings. New emails, native invoice creation and
payment actions were not part of this repair.

## Verification limits

The exercised local browser flows and hosted read contracts now have separate
evidence. The hosted probes validate repaired aggregates and per-student reads;
they do not establish an authenticated hosted browser latency distribution,
every pagination boundary, every viewport or all account-role combinations.
Future source corrections still require explicit reviewed associations and
current revisions. No new hosting subscription or payment provider was added.
