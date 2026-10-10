# Architecture, performance and security audit — 10 October 2026

## Scope and conclusion

Application baseline: `2a442139a81960a80a1ffd19660128756b617b66`. Live target: `https://tuts.palladiumscholars.com`. Reviewed repository source, migrations, dependencies, Git branch state, live Cloudflare settings and ordinary-role Neon metadata; exercised synthetic local tests and public HTTP requests. Documentation/CI/test corrections in this audit do not change the deployed application runtime.

**Documentation was behind the product.** GitHub's default `main` was `5b87bf7`, while deployed work was pushed on `feat/student-workspace`. Several contract introductions still said eight services, no portal, and local-only file storage. Queue tables omitted merge/Planning/Reporting subscriptions. This audit updates the current docs, adds generated ownership/route inventory and records implementation limits. Historical release reviews remain dated evidence.

**Service decoupling remains intact.** Source import boundaries pass across ten services; databases/roles are separate and Reporting composes other domains through HTTP/events. Current latency risks are concentrated in the shared Worker transport, connection lifecycle, bootstrap, caches and aggregate work. Keeping domain boundaries does not require keeping these costs.

**No critical exploitable authorization bypass was demonstrated in this review.** That is not a guarantee of absence. Four dependency advisories, missing consistent private cache headers, abuse controls, CSP and recovery/retention coverage need work. Password recovery mail is disabled in inspected production settings. The OpenAPI endpoint is broken in the reproduced Node bootstrap.

## Evidence and limits

| Check | Result |
| --- | --- |
| Service source/package boundaries | Passed, ten independently owned packages |
| Ten live database runtime roles | All non-superuser, no BYPASSRLS |
| Cross-service database CONNECT grants | Each role can connect to its own `tuts_*` database and none of the other nine |
| Live tenant-table metadata | 78 tables carry `business_id`; 76 ENABLE/FORCE RLS; two intentional private directories are exempt |
| Database-backed local suites | Platform, Clients, Scheduling, Learning, Billing, Payments, Notifications and Reporting: **125 tests passed, zero skipped** |
| Complete root test run | **197 passed, 14 skipped, zero failed**; the 14 skipped database tests were subsequently exercised in the database-backed suites above |
| Type checking/build | Passed across the workspace |
| XLSX Worker runtime regression | Passed repeated/concurrent uploads, forged entry sizes, archive limit, malformed ZIP and subsequent recovery |
| Cloudflare configuration tests | Passed |
| Production settings | Ten domain Workers targeted; no Hyperdrive bindings; persistent sanitized logs enabled; automatic traces disabled |
| Production delivery flags | Platform/Notifications `AUTH_MAIL_ENABLED=false`; outbound campaigns and sandbox payments false |
| Secrets review | Private local/config paths ignored; no `.env`, private key files, `.cloudflare` or `.local` files found in the checked Git path history. This is not a full secret-content scanner or proof no past leak exists. |
| Browser inspection | Production sign-in page loaded in an isolated background tab. Raw CDP permission was declined; no browser waterfall, CPU trace or Core Web Vitals measurement was collected. |

No production customer records were modified, imported, messaged or charged. Hosted account workflows, provider delivery, full-volume query plans, concurrency/load tests, disaster restoration and authenticated production browser traces were not exercised. They remain explicit verification gaps.

### HTTP timings

Five sequential requests per endpoint, no artificial network throttling. Public production requests were anonymous; local requests used a synthetic tutor workspace and persistent Node/local PostgreSQL processes. TTFB is measured until the HTTP client receives response headers. These small samples are **not p95 estimates**, and local timings are not a production forecast.

| Environment / route | Status | TTFB samples, ms | Median, ms |
| --- | --- | --- | --- |
| Production `/` | 200 | 620, 160, 160, 154, 144 | 160 |
| Production `/api/platform/v1/session`, no cookie | 401 | 182, 189, 169, 916, 193 | 189 |
| Production `/api/clients/v1/clients`, no selected business/cookie | 400 | 145, 157, 167, 199, 271 | 167 |
| Local authenticated business list | 200 | 46, 7, 5, 4, 5 | 5 |
| Local authenticated CRM, limit 50 | 200 | 44, 13, 15, 17, 9 | 15 |
| Local authenticated dashboard aggregate | 200 | 49, 14, 12, 14, 11 | 14 |
| Local authenticated one-student summary POST | 201 | 21, 9, 8, 9, 9 | 9 |

Production HTML reported an edge cache HIT. General API/error responses lacked Cache-Control; local successful business/CRM/dashboard/summary responses also lacked it. Anonymous failures do not benchmark authenticated database work. No inference that the 916 ms outlier was Neon wake-up is justified by these measurements.

The built homepage references 13 JS/CSS files and **1,390,719 raw JavaScript bytes**. Locally gzipping those JavaScript files yields 384,981 bytes; that is an estimate, not observed transferred bytes. The largest referenced chunk is 516,174 raw bytes. [Main-page imports](../../apps/web/app/page.tsx) eagerly include the feature screens. A browser trace is still needed to allocate parse/hydration cost.

## Performance findings

Priority means remediation order, not a vulnerability score. P1: address next; P2: measured follow-up; P3: subsequent hardening. All performance recommendations below remain **open**, unless explicitly marked corrected.

| ID / priority | Finding and evidence | Proposed change / acceptance criteria |
| --- | --- | --- |
| P-01 / P1 | [Worker adapter](../../packages/service-kit/src/worker.ts) awaits `flushOutbox()` after every <400 HTTP response, including GETs. [EventBus](../../packages/service-kit/src/events.ts) starts a transaction, scans/locks up to 50 pending rows and may await queue fanout before returning the user's response. A successful read can therefore pay for unrelated writes. | Remove read-path publication and move committed mutation publication into registered background work. Preserve transaction/outbox guarantees, partial-fanout retries, scheduled recovery and invocation pool lifetime. Compare identity/target/outbox phases before/after; failed publication must not lose committed events. |
| P-02 / P1 | [Invocation pools](../../packages/service-kit/src/runtime.ts) create fresh pools (max two sockets) and close them each invocation. Protected routes additionally invoke Platform first. Live settings have no Hyperdrive bindings despite an existing optional adapter. | Pilot pooled connections with query caching disabled. Verify tenant isolation, auth revocation, concurrent transactions and financial freshness; compare warm/cold production timing and connection counts. Do not retain sockets across Worker invocations improperly. |
| P-03 / P1 | [Tutor bootstrap](../../apps/web/app/page.tsx) awaits session, then businesses, then feature mount. All feature screens are imported into the initial composition page. | Introduce a scoped bootstrap response or safe parallel reads, plus lazy feature chunks. Measure initial JS bytes and authenticated time-to-data on a fixed device/network. Preserve per-request membership checks. |
| P-04 / P2 | [Platform workspace listing](../../services/platform/src/businesses.controller.ts) loops over up to 100 memberships, awaiting a tenant transaction/policy resolution for each. This is a real serial loop; it is not the normal tracker-card summary path. | Use an actor-authorized bounded directory projection and selected-workspace policy resolution, with revocation/invitation tests. Do not solve it through unrestricted cross-tenant SQL or a client-side cached grant. |
| P-05 / P1 | [API cache](../../apps/web/lib/api.ts) caches only GET reads for 15 seconds, clears the business cache on mutation, and does not coalesce/cache Reporting summary POST reads. [List state](../../apps/web/lib/use-list-query.ts) is mounted-view scoped; feature unmounts recreate loading state. | Keep bounded, permission-scoped view snapshots during navigation and refresh; cache read-only summaries by query identity and target invalidation by resource. Clear on logout/account/business/policy changes. Show refreshing indicators alongside retained data, rather than blank global Loading. |
| P-06 / P2 | [Reporting summaries](../../services/reporting/src/reporting.service.ts) take [the exclusive business advisory lock](../../services/reporting/src/projections.ts), also used by activity/projection writes. Reads can queue behind one student's write/reconciliation. | Investigate snapshot/versioned projection consistency and narrower locks. Concurrent merge/reconcile/activity tests must prove aliases and coverage cannot diverge. Keep existing lock until that proof exists. |
| P-07 / P2 | [Billing analytics](../../services/billing/src/history-analytics.ts) serially executes multiple aggregates and scans all history for totals/trends. Timezone/date casts may limit effective index filtering. | Profile actual plans at realistic volumes; owner-service incremental daily/monthly aggregates with revision/rebuild semantics if justified. Never materialize a shared cross-service database or count a work payment twice as invoice revenue. |
| P-08 / P2 | Workbook parsing, raw history storage in PostgreSQL and bridge `arrayBuffer()` create full in-memory bodies/copies. [Tracker reconciliation](../../apps/web/features/student-tracker.tsx) explicitly fans out per student, although normal summaries are batched. | Benchmark maximum valid files and reconciliation batches. Consider owned R2 source archives/queued parse or reconcile jobs with progress, quotas, idempotency and retry. Do not perform source reconciliation just to render cards. |

Reporting's current batch is already a useful improvement: four domain SQL statements for 1–100 IDs, five with finance, verified with real PostgreSQL for 50 cards. These counts exclude BEGIN/COMMIT, transaction-local tenant setup and transport outbox queries. Dashboard overview uses one client request and concurrent source composition. Replacing these with a shared database would weaken boundaries without addressing P-01/P-02.

## Security and reliability findings

### Dependency advisories: S-01 / P1 triage

`pnpm audit --prod --json` reported **one high and three moderate advisories**, zero critical, across 319 production dependencies. Advisory severity is not proof its trigger is reachable through Tuts.

| Package / advisory severity | Reported dependency path | Reachability review and remediation |
| --- | --- | --- |
| `braces`, high | Node gateway → http-proxy-middleware → micromatch → braces | [Deep-pattern stack exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Current proxy routes use fixed configuration; no attacker-selected glob path was identified. The production gateway has its own fetch-based Worker entry, rather than the Node proxy middleware. No patched version was reported by the audit. Evaluate removing/replacing the Node proxy dependency or upstream fix, with routing regressions; do not label production compromised. |
| `csv-parse`, moderate | Billing → csv-parse | [Columns-path prototype replacement advisory](https://github.com/advisories/GHSA-8cw4-87c7-c6xx), patched 7.0.2 reported. Current CRM/Billing parsers read array records without enabling the vulnerable `columns` option. Upgrade with header/prototype-key/malformed CSV regressions and compatibility review. |
| `js-yaml`, moderate | service-kit → Nest Swagger → js-yaml | [Empty-source YAML merge CPU advisory](https://github.com/advisories/GHSA-r3ph-w7gj-g6xm), patched 5.4.1 reported. User uploads do not parse YAML; no user-controlled YAML endpoint was identified. Update the compatible dependency path and recheck generated specs/build. |
| `uuid`, moderate | Billing → ExcelJS → uuid | [v3/v5/v6 buffer bounds advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq), patched 11.1.1 reported. Reviewed ExcelJS usage generates v4 IDs, whose API is outside this specific trigger. Avoid blindly forcing a major transitive release into ExcelJS; verify importer/exporter compatibility or upstream patch. |

### Other findings

| ID / priority | Finding | Required action |
| --- | --- | --- |
| S-02 / P2 | Gateway adds no-store only to recovery/auth paths; most protected domain JSON lacks a consistent cache policy. No cross-tenant cache disclosure was reproduced. | Apply private/no-store to protected APIs and vary relevant origin headers; keep static immutable caching separate. Test success/error responses, logout, account/business changes and maintenance paths before enabling API caching. |
| S-03 / P2 | HSTS/nosniff/frame-denial exist, but the application lacks a general CSP. No stored/reflected XSS exploit was demonstrated. | Add compatible report-only CSP, inventory allowed scripts/styles/frames, then enforce nonce/hash-based policy; include Next hydration, safe booking and essay-link regressions. |
| S-04 / P2 | Identity has database rate limits; expensive authenticated uploads/reporting/reconcile and public ingestion lack a consistent actor/tenant quota and concurrency model. Full response buffering/parser copies increase resource-exhaustion risk. | Add bounded per-tenant/actor budgets and background jobs where appropriate. Load-test maximum valid uploads and repeated requests; preserve safe retries and do not log private inputs. |
| S-05 / P2 | No documented automatic retention/pruning for published outbox, inbox, staged/history sources and activity receipts. R2 transport pointers expire after seven days. Arbitrary pruning could invalidate dedup or orphan a pending payload. | Define retention classes, DLQ recovery window, pending-event retention, source deletion/export and safe replay rules. Keep financial history according to an explicit policy. Test recoverability before pruning. |
| S-06 / P2 | No current hosted disaster-restore exercise or verified scheduled backup policy was established in this audit. Historical migration snapshots exist; GCP backup documentation does not prove Cloudflare/Neon backups. | Verify Neon retention/current plan, encrypted off-provider snapshots, R2 objects, key/config backups and a restored isolated tenant/service set. Document recovery point/time objectives after measurement. |
| S-07 / P2 | Private documents are type/size bounded, but no malware scanning is implemented. | Keep private attachment downloads and avoid arbitrary inline HTML; define quarantine/scan needs before opening uploads to wider audiences. |
| A-01 / P1 operational | Live Platform and Notifications have `AUTH_MAIL_ENABLED=false`; local deployment secret metadata has no configured system sender. Invitation/reset UI does not imply mail can be delivered. | Configure/verify a sender, enable both services deliberately, test known/unknown-account requests, real inbox receipt, token expiry/reuse/session revocation and delivery failures. Do not claim this feature operational before delivery proof. |
| A-02 / P1 governance | CI originally only built and exercised workbook runtime; two stale tests failed in a complete suite. Database tests silently skip without configuration. | **Corrected here:** repair stale mocks, run complete non-database tests, typecheck, boundaries and generated inventory checks in CI. A mandatory ordinary-role PostgreSQL CI job is still needed; local DB test evidence is recorded above. |
| A-03 / P1 architecture | `/openapi.json` returns 404 on the running local service and a fresh minimal `createServiceApplication(..., false)` app. Bootstrap registers the route after `app.init()` installs Nest's not-found handler. | Register documentation before final router initialization and add HTTP smoke coverage. Zod request/response schemas also need explicit documentation; route inventory is not a complete OpenAPI schema. **Not fixed in this audit.** |
| A-05 / P1 recovery | [Initial migration script](../../scripts/migrate-local-data.mjs) still enumerates eight services and legacy table allowlists. Its exact-schema validation rejects current expanded table sets; Planning/Reporting are absent. | Keep the original cutover procedure historical. Implement a complete schema/version-aware backup/restore workflow and test isolated restoration of all ten databases, keys and R2 files. The current tool fails closed; do not disable that check to force a restore. |
| A-04 / P2 data quality | Historical engagement groups by unlinked student names. Identical names may combine and spelling changes may split; churn is inactivity and provisional. | Link reviewed historical rows to canonical CRM identities without changing preserved source, retain unknown/ambiguous coverage, and test duplicate names before person/cohort decisions. |

## Delivery and remediation order

1. **Documentation/governance:** align the default GitHub branch with already deployed source, publish current architecture/API inventory/audit, gate docs/boundaries/tests in CI. Preserve history; do not delete branches as part of this review.
2. **Release blockers:** configure real recovery/invitation delivery, fix the OpenAPI route, triage/patch advisory paths and add a required database CI job.
3. **Fast-loading baseline:** instrument connect/query/outbox phases and capture an authenticated production browser trace; address read-path outbox work and pooling first, then bootstrap/lazy chunks/scoped retained snapshots. Publish comparable before/after measurements.
4. **Concurrency/scale:** replace broad reporting read locks only after consistency tests; benchmark history aggregates/files/reconciliation and implement domain-owned projections/background jobs as needed.
5. **Hardening/operations:** private API cache headers, CSP, quotas, retention, recovery tests and frontend error capture with redaction.

These are separable changes. Each should state affected services, migration/binding needs, feature flags, rollback, tests and measured outcome. No performance gain, email delivery or vulnerability remediation is claimed merely because this plan was documented.
