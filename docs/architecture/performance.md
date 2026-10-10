# Performance architecture

Baseline `2a44213`, reviewed 10 October 2026. The [audit](../reviews/2026-10-10-platform-audit.md) separates measurements from source-based hypotheses. The browser was inspected visually, but raw browser debugging permission was declined; no Lighthouse/Core Web Vitals results are claimed.

## Loading paths today

1. Static Next/React assets load through Cloudflare.
2. Initial tutor page awaits session, then business list, then mounts the selected feature and starts its data requests.
3. A domain request asks Platform to validate session/membership before calling its private service Worker.
4. Each Worker invocation creates its own PostgreSQL pool (maximum two sockets), executes tenant transactions, buffers the response, attempts outbox publication after every successful request, then closes its pool.
5. Feature state is mostly component-local. Unmount/revisit may recreate loading state even when a short API cache has recent data.

The browser calls APIs; it does not read PostgreSQL directly. Independent databases/services should remain. Performance improvements belong at transport, query, aggregate and interaction boundaries.

## Existing protections and improvements

- CRM/tracker server pagination normally requests 50 rows, not the entire database. Search filters/debounce/cancellation prevent obsolete filtered results winning.
- Reporting student batches use four SQL statements (five with finance) for 1–100 requested students. They do not perform one query/source fetch per card during normal load.
- Dashboard overview uses one Reporting request; Reporting fetches Clients counts and Billing analytics concurrently.
- API GET caches are memory-only, scoped to the mounted business API, expire after 15 seconds and coalesce identical pending reads. Writes invalidate the current business cache. They never replace backend authorization.
- List refresh retains previous successful results within the mounted view. Kanban has immediate local updates and ordered background persistence with visible recoverable errors.
- Domain Workers use targeted placement near the manifest's Neon region; gateway/assets stay at the edge. Gateway emits `Server-Timing` and sanitized identity/upstream/total durations.

## Remaining expensive work

| Boundary | Current cost | Planned remedy and correctness requirement |
| --- | --- | --- |
| Worker response → outbox | Even reads await BEGIN/select/COMMIT and may publish unrelated backlog | Publish mutations/consumer effects through registered background tasks; preserve periodic recovery and invocation-owned sockets; measure durable retry before rollout |
| Invocation → PostgreSQL | Fresh pools/sockets and cleanup per invocation; no live Hyperdrive bindings | Trial Hyperdrive pooling with **query caching disabled**, verified TLS and tenant/session tests; measure before broader rollout |
| Browser bootstrap | Session → businesses → view waterfall; eager imports of all main-page features | Composed authorized bootstrap and lazy feature chunks; avoid introducing stale grants or extra security round trips |
| Workspace list | Platform loops over up to 100 memberships, awaiting a tenant transaction and policy resolution for each | Return a bounded actor-authorized directory projection and resolve selected-workspace policy separately; preserve revocation and avoid bypassing RLS for a broad join |
| Navigation cache | View state disappears; POST summary reads are not cached/coalesced by the GET cache | Per-account/business/student/query snapshots with bounded expiry, targeted invalidation and retained data during refresh |
| Reporting tenant lock | Read summaries take the same exclusive tenant lock as projection/activity writes | Snapshot/repeatable-read or immutable projection revisions; preserve merge consistency and test concurrent merges before narrowing locks |
| Billing analytics | Several serial queries, all-history aggregates/trend grouping | Measure plans/row counts; build owner-service daily/monthly aggregates updated by work/invoice mutations and events, with rebuild/coverage contracts |
| Tracker reconcile | Explicit per-student historical reconciliation with bounded concurrent fanout | Separate queued/batched reconciliation job and progress; do not start it merely to render a page |
| XLSX/files | In-memory parser and response copies, archived source bytes in PostgreSQL | Profile max-sized workloads; preserve private raw sources in owner-controlled object storage and decouple heavy parsing if measurements justify it |

[Hyperdrive pooling](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/) uses transaction boundaries. [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) is a separate behavior and is not assumed safe for transaction-local tenant state, revocation or financial reads. A shared SQL-result cache is not the same as connection pooling.

## Proposed budgets

These are targets, **not measured guarantees**:

| Interaction | Target | Measurement |
| --- | --- | --- |
| Card drop/row selection | Local feedback in <100 ms, no global blocking state | Browser interaction trace, delayed-response test |
| Returning to a visited view | Retained scoped snapshot immediately; refresh in background | Authenticated navigation test with slow API |
| Warm protected page aggregate | p95 <1 s server-side, excluding provider sync | Gateway identity/upstream timing across representative production traffic |
| Warm first data display | p95 <2 s on defined reference device/network | Authenticated browser cold/warm trace |
| Cold compute/database request | Measured and separately reported, bounded timeout | First request after verified idle period; provider/database phase spans |
| 50-card tracker | One paginated list and one summary batch, constant SQL count | Integration assertions plus realistic query plans |

Do not hide stale/missing financial data behind a cache. Keep `asOf`, source coverage and explicit Refresh. Invalidate after tenant/account/student permission changes; clear on logout. Avoid arbitrary fixed minimum loading delays.

## Measurement protocol

Keep public asset timings, anonymous errors, local authenticated requests and production authenticated interactions separate. Record release, date, sample count, network/device, cold/warm definition, status, body size and server timings. Five samples are a diagnostic snapshot, not a p95 benchmark. Compute browser metrics only from a real trace; source inspection cannot establish LCP/INP/CLS.

Profile Clients/Billing/Reporting inside their own database with ordinary-role tenant transactions and `EXPLAIN (ANALYZE, BUFFERS)` on synthetic or authorized data. Aggregate timing/counts can be shared; customer rows, tokens and raw SQL parameter logs must remain private. Test realistic history volumes, concurrent users, student aliases and slow/unavailable optional services. Re-run baseline and changed implementation on the same dataset.
