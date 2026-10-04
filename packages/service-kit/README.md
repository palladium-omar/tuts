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
