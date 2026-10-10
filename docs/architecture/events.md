# Events and consistency

> **Contract scope:** Tuts includes RabbitMQ transport, per-service databases, transactional outbox/inbox support, and durable queues. This page also specifies the consistency guarantees and event catalogue expected as workflows are extended; catalogue entries and optional consumers are not a blanket claim that every producer/consumer flow is currently active. Check the [repository status](../../README.md#what-works-today) and service READMEs for shipped handlers.

RabbitMQ topic exchange: `palladium.events`. Each consuming service has its own durable queue, binding declared event names. Messages are persistent. Publishing uses publisher confirms; consumers use manual acknowledgements and bounded retry/dead-letter handling. Delivery is at least once and consumers must tolerate duplicates and reordering.

## Envelope

```json
{
  "id": "uuid",
  "type": "payments.payment-confirmed.v1",
  "version": 1,
  "producer": "payments",
  "businessId": "uuid",
  "occurredAt": "2026-10-03T12:00:00.000Z",
  "correlationId": "uuid",
  "data": {
    "paymentId": "uuid",
    "invoiceId": "uuid",
    "amountMinor": 12000,
    "currency": "USD",
    "provider": "sandbox",
    "simulated": true
  }
}
```

Event payloads contain the minimum required information and never credentials, session cookies or card/bank-account details. Business IDs in broker messages are trusted only because broker credentials and exchange permissions restrict publishers; the broker is a private infrastructure boundary.

## Transactional outbox and inbox

Every business mutation and its outgoing events commit in one local PostgreSQL transaction. A service-owned outbox dispatcher publishes committed events and marks them sent only after broker confirmation. The event can be published twice if the dispatcher crashes after confirmation.

Consumers insert `(consumer, event_id)` into an inbox in the same transaction as applying their state change. An existing key is acknowledged without reapplying it. On rollback the inbox write also rolls back. Provider webhook IDs are separately deduplicated by provider connection. A queue acknowledgement happens only after commit. Repeated failures enter the service's dead-letter queue; operators can replay the original event ID after fixing the cause.

Financial status transitions must be monotonic or explicitly reconciled. A stale provider notification cannot change a confirmed payment back to pending. An unknown invoice/payment reference is retained for investigation/retry, never silently treated as settled.

## Selected event catalogue

The table covers cross-service flows relevant to the current implementation. Individual service READMEs document their other emitted events.

| Event | Producer | Consumer | Required payload |
| --- | --- | --- | --- |
| `clients.client-created.v1` | clients | notifications, optional | clientId |
| `clients.source-synced.v1` | clients | integrations | connectionId, created, updated, skipped, errors, issues, receivedAt |
| `scheduling.session-created.v1` | scheduling | notifications | sessionId, clientId, startsAt |
| `scheduling.session-completed.v1` | scheduling | notifications | sessionId, clientId |
| `learning.assignment-created.v1` | learning | notifications | assignmentId, clientId, dueAt |
| `billing.invoice-issued.v1` | billing | payments invoice projection, notifications | invoiceId, amountMinor, currency |
| `payments.payment-confirmed.v1` | payments | billing, notifications | paymentId, invoiceId, amountMinor, currency, provider |
| `platform.business-profile-updated.v1` | platform | billing | businessId, name, profile, branding, revision |
| `integrations.contacts-received.v1` | integrations | clients | connectionId, source, contacts (up to 200) |
| `integrations.sessions-synced.v1` | integrations | scheduling | connectionId, provider, ownerUserId, sessions (up to 200) |
| `integrations.connection-disconnected.v1` | integrations | clients, scheduling | connectionId |

Optional automation must check tenant configuration. Financial reconciliation consumers continue settling previously accepted payments even after feature access changes. Emit a new event version for incompatible payload changes. Adding consumers must not require changing the producer's implementation.

## Active subscription registry (10 October 2026)

Cloudflare uses per-consumer queues and private R2 pointers for oversized envelopes; Node uses RabbitMQ. The registry is the exact subscription source for fanout and provisioning. Selected examples above are not its complete list. Changes must update contracts, handlers, transport configuration, docs and retry tests together.

| Consumer queue | Subscribed event types |
| --- | --- |
| billing | `payments.payment-confirmed.v1`, `platform.business-profile-updated.v1`, `scheduling.class-updated.v1`, `clients.student-merged.v1` |
| integrations | `clients.source-synced.v1` |
| clients | `integrations.contacts-received.v1`, `integrations.connection-disconnected.v1` |
| scheduling | `clients.student-merged.v1`, `integrations.sessions-synced.v1`, `integrations.connection-disconnected.v1` |
| planning | `clients.student-merged.v1` |
| reporting | `scheduling.class-updated.v1`, `learning.assignment-created.v1`, `learning.assignment-submitted.v1`, `learning.assignment-reviewed.v1`, `learning.assignment-updated.v1`, `learning.resource-created.v1`, `learning.resource-updated.v1`, `billing.invoice-updated.v1`, `clients.student-merged.v1` |
| learning | `clients.student-merged.v1` |
| payments | `billing.invoice-issued.v1` |
| notifications | `clients.client-created.v1`, `clients.client-updated.v1`, `scheduling.session-created.v1`, `scheduling.session-completed.v1`, `learning.assignment-created.v1`, `billing.invoice-issued.v1`, `payments.payment-confirmed.v1` |
