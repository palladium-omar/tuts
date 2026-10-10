# Performance architecture

Updated for the 10 October 2026 audit remediation. The [baseline audit](../reviews/2026-10-10-platform-audit.md) and [remediation receipt](../reviews/2026-10-10-audit-remediation.md) distinguish source changes, local measurements and verified deployment. Independent services/databases remain the architecture.

## Request and loading path

1. Cloudflare serves the static Next/React shell. Feature screens load in separate chunks when selected.
2. `/api/platform/v1/bootstrap` checks the session once and returns its authorized business directory. Each subsequent protected request still verifies membership/capabilities on the backend.
3. Gateway forwards the authorized context to a private domain Worker. PostgreSQL pools remain invocation-owned (two sockets maximum), with optional per-service Hyperdrive **connection pooling, SQL query caching disabled**. No client accesses PostgreSQL directly; no Worker shares a socket from an ended invocation.
4. A read performs its controller work and bounded response transport; GET/HEAD/OPTIONS do not publish the outbox. Successful mutations register publication as background work. The invocation lifetime includes that work and pool cleanup. Queue consumption waits for durable processing/publication before acknowledgment. A gateway cron ticks every domain for recovery.
5. Exact view snapshots and GET/read-only Reporting summary results live in bounded browser memory. Returning to a screen retains authorized data while refreshing. Mutation starts and completion invalidate dependent snapshots; a generation check prevents an older in-flight read repopulating an invalidated cache.

## Cache contract

- Identity is the API instance: account, business, role, permissions, entitlements and student scope. Student portal identities also include author/access scope.
- Snapshot retention is two minutes, freshness thirty seconds. Reads coalesce by exact query/body; capacity is bounded. These are browser caches, not shared edge/SQL caches.
- API disposal, logout, context/policy changes and 401/403 clear private state. Backend authorization is always authoritative.
- Mutations invalidate their own domain and dependent Reporting reads before and after the write; diagnostics do not invalidate product data. Errors remain visible with safe retry behavior.
- General API success/error responses declare private/no-store. Static resources retain their independent immutable caching policy.

## Query and concurrency contracts

| Operation | Contract |
| --- | --- |
| Workspace directory | Up to 100 actor-authorized memberships; at most four tenant transactions concurrently, retaining each tenant's RLS/policy resolution |
| CRM/tracker list | Pagination, usually 50 rows; filtering/debounce/cancellation prevent obsolete results winning |
| Student summaries | Four domain statements for 1–100 IDs, five with finance; alias/coverage checks before reads. Shared tenant advisory locks permit overlapping readers; projections/merges/activity use exclusive locks |
| Dashboard | One browser aggregate request; Clients/Billing source calls concurrent and independently report unavailable coverage |
| Billing history analytics | Five aggregate statements in a repeatable-read snapshot; monthly class timestamp ranges permit index use. Exact money and separate currencies. Unreviewed source names produce unknown person metrics |
| Assignment list | One batched resources query per page; three domain statements for 1/50/100/200 cards |
| Tracker reconcile | Explicit, bounded concurrent operation; never automatically triggered to render a page |
| Kanban | Immediate local updates, ordered background persistence and recoverable errors; reading/writing remains through Planning APIs |

Statement counts exclude transaction setup, authorization, transport and request-budget transactions. An index-forced synthetic plan proves eligibility, not production speed. No incremental financial aggregate store is needed until actual-volume measurements justify its extra consistency/rebuild cost.

## Resource limits

Request transport is capped at 32 MiB, responses at 64 MiB; domain upload limits are lower (5 MB CRM/history, 20 MB Learning). Transport still buffers completed responses to preserve controller/socket lifetime. This is bounded buffering, not streaming/queued ingestion. Expensive requests have durable per-minute actor/tenant budgets and Retry-After responses; [security](security.md) lists the limits. These are rate budgets, not a simultaneous-job scheduler.

Large-file parsing and explicit history reconciliation remain candidates for owner-service jobs if measured load requires them. A service-owned job should persist idempotency, progress, retry/expiry, result and source identity; publish completion through the same outbox. Do not share domain tables or weaken RLS to make a screen faster.

## Evidence and monitoring

The final referenced homepage JavaScript fell from 1,391,360 to 992,567 raw bytes in comparable builds (28.7%). This is a build payload measurement, not a measured improvement in real-user time-to-data. Maximum archive corruption/concurrency tests exercise the XLSX Worker runtime. Database suites exercise ordinary roles and Reporting reader/writer concurrency.

Gateway identity/upstream/total durations and domain connection/transaction/target/outbox phases are sanitized structured logs. Browser diagnostics report only enumerated error kind, coarse section/source and capped counts; no messages, stacks, URLs or private input.

Operational targets, not current guarantees: retained navigation feedback immediately; warm server aggregate p95 below one second; first data below two seconds on a defined reference device/network. Collect representative authenticated timings before asserting these targets. Raw browser debugger permission was declined in the baseline review; no Core Web Vitals, Lighthouse or production p95 is claimed. Hyperdrive removes origin connection setup costs, but region/idle database/queries/provider calls still matter. See [Cloudflare pooling](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/).
