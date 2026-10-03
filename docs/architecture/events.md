# Events and consistency

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
    "provider": "stripe"
  }
}
```

Event payloads contain the minimum required information and never credentials, session cookies or card/bank-account details. Business IDs in broker messages are trusted only because broker credentials and exchange permissions restrict publishers; the broker is a private infrastructure boundary.

## Transactional outbox and inbox

Every business mutation and its outgoing events commit in one local PostgreSQL transaction. A service-owned outbox dispatcher publishes committed events and marks them sent only after broker confirmation. The event can be published twice if the dispatcher crashes after confirmation.

Consumers insert `(consumer, event_id)` into an inbox in the same transaction as applying their state change. An existing key is acknowledged without reapplying it. On rollback the inbox write also rolls back. Provider webhook IDs are separately deduplicated by provider connection. A queue acknowledgement happens only after commit. Repeated failures enter the service's dead-letter queue; operators can replay the original event ID after fixing the cause.

Financial status transitions must be monotonic or explicitly reconciled. A stale provider notification cannot change a confirmed payment back to pending. An unknown invoice/payment reference is retained for investigation/retry, never silently treated as settled.

## Initial event catalogue

| Event | Producer | Consumer | Required payload |
| --- | --- | --- | --- |
| `clients.client-created.v1` | clients | notifications, optional | clientId |
| `scheduling.session-created.v1` | scheduling | notifications | sessionId, clientId, startsAt |
| `scheduling.session-completed.v1` | scheduling | optional billing workflow | sessionId, clientId; price/payer snapshot only if configured |
| `learning.assignment-created.v1` | learning | notifications | assignmentId, clientId, dueAt |
| `billing.invoice-issued.v1` | billing | payments invoice projection, notifications | invoiceId, amountMinor, currency |
| `payments.payment-confirmed.v1` | payments | billing, notifications | paymentId, invoiceId, amountMinor, currency, provider |

Optional automation must check tenant configuration. Financial reconciliation consumers continue settling previously accepted payments even after feature access changes. Emit a new event version for incompatible payload changes. Adding consumers must not require changing the producer's implementation.
