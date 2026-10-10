# Shared runtime

The Node bootstrap retains RabbitMQ and the local PostgreSQL pool. The Worker
entrypoint uses private service bindings, Cloudflare Queues, and invocation-owned
PostgreSQL pools. Its private POST `/__runtime/tick` requires the runtime bearer
secret and recovers pending outbox rows.

## Large event transport

Events at most 100,000 UTF-8 JSON bytes are sent directly to Queues. Larger events,
up to 8 MiB, are written to the private `EVENT_PAYLOADS` R2 binding. The queue
contains a versioned reference with the event identity, validated object key, and
SHA-256 digest. Consumers bound the object read and verify its digest, size, and
identity before executing the normal tenant transaction and inbox deduplication.
The domain event contracts remain unchanged. The payload bucket has no public
URLs or public access.

Objects use create-only conditional writes. Partial fanout and duplicate delivery
retain the same object. An R2 or queue failure leaves the outbox unpublished;
consumer failures retry without committing the inbox entry. Payload objects expire
after seven days; active Queue retention is 24 hours. Operators must resolve or
replay dead-letter entries within that retention window. After payload expiry,
the producer's full `service_outbox.event` JSON remains available for recovery:
republication recreates the immutable object before sending a new reference.
Outbox publication is recorded only after all contract destinations accept it.

## Runtime hardening (October 2026)

Worker reads never publish unrelated outbox entries. Successful mutations register
publication as invocation background work; `waitUntil` retains the invocation's
pools until publication finishes. Without a background context cleanup awaits the
registered work. Queue consumers and authenticated scheduled ticks retain their
awaited publication/retry semantics. Failed publication leaves pending records
for the next tick. Safe diagnostic phases cover connection acquisition,
transactions, target dispatch and background publication; these are durations,
not SQL/query text or private payloads.

All domain responses, including errors and OpenAPI, use private/no-store and vary
on Origin, Authorization and Cookie. OpenAPI is mounted before Nest initializes
its fallback router; its generated schemas still depend on controller annotations.

Apply `Database.migrate` to **every service database before deploying** this runtime.
It creates `service_request_budgets` and the retention indexes. The expensive-route
guard applies atomic database-backed one-minute budgets to Reporting reads,
imports/uploads/reconcile/sync mutations and public ingestion routes. Authenticated
budgets are 20 actor/60 tenant operations per minute (Reporting: 120/300); public
ingestion uses a service-wide 120/minute budget. Client tenant and IP headers cannot
create identities. Rejected transactions roll back all budget counters and return
429 with Retry-After: 60. Budgets cover request rate; active-operation concurrency
leases and parse/reconcile queues are not implemented here.

Worker transport caps request streams at 32 MiB (domain parsers enforce lower
limits) and buffered response streams at 64 MiB. A declared oversized request
returns 413. Stream overruns fail closed, though bridge/parser handling may report
an internal error. The bridge still buffers completed responses to keep controller
work inside its invocation; bounded buffering is not full streaming or an upload
job architecture.

Authenticated ticks and Node broker maintenance delete at most 1,000 published
outbox payloads older than 30 days per run. Pending/partially published events are
never deleted. Inbox IDs remain permanent replay tombstones: deleting them would
permit old deliveries to reapply business side effects. Producer payload replay
beyond 30 days requires separately retained source and a new reviewed event;
this routine does not establish financial/source/activity retention policy or a
hosted disaster recovery guarantee. Request budget buckets expire after one day.

Invocation pools retain at most two sockets until request/background cleanup; idle expiry is disabled within that bounded lifetime. Asynchronous socket diagnostics retain their original request owner.
