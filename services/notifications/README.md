# Notifications service

Independent NestJS process on port 4007 and private PostgreSQL database. Requires `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` and the `notifications` entitlement for HTTP requests. APIs are restricted to owner/admin/tutor staff.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/v1/notifications` | `{items}`; optional status/limit; default 100, max 200 |
| POST | `/v1/notifications` | Persist a manual queued intent |
| PATCH | `/v1/notifications/:id` | Mark queued in-app notification read or cancel a queued intent |

Manual intent request:

```json
{"title":"Practice reminder","message":"Review algebra before the next session","channel":"in_app","recipientClientId":"11111111-1111-4111-8111-111111111111"}
```

channel defaults to in_app; recipientClientId is optional and is an opaque reference. Responses use `{item}` with id/businessId/sourceEventId/sourceEventType/recipientClientId/channel/title/message/status/deliveryMode/metadata/createdAt/updatedAt. All intents begin `status:"queued"` with `deliveryMode:"queue_only"`. PATCH accepts `{status:"read"}` or `{status:"cancelled"}`. Email cannot be marked read. No provider is connected, no email/SMS is sent and no delivery success is represented. A configured delivery adapter, recipient lookup/preferences, consent and user authorization are pending.

OnModuleInit registers subscriptions for:

- clients.client-created.v1
- scheduling.session-created.v1
- scheduling.session-completed.v1
- learning.assignment-created.v1
- billing.invoice-issued.v1
- payments.payment-confirmed.v1

The shared EventBus applies each event in a tenant transaction and deduplicates through its transactional inbox. A unique (business_id, source_event_id) key additionally protects notification effects. Handlers store only validated catalogue fields, generate a generic title/message and discard unknown event fields. Poison payloads fail the transaction and follow broker retry/dead-letter policy. In-app intents form a staff activity queue; they do not expose student documents or recipient portal access.

Tenant domain rows force PostgreSQL RLS; caller tenant fields are rejected. Consumption creates queued facts without external actions. Entitlement enforcement applies to protected HTTP routes; durable broker facts may still be retained for a tenant whose feature access later changes.

Run `pnpm --filter @palladium/notifications typecheck`, `build`, or `test`. Database tests require `NOTIFICATIONS_TEST_DATABASE_URL` for an isolated database using a non-superuser role without BYPASSRLS. Live RabbitMQ inbox/acknowledgment/retry behavior belongs to the shared runtime integration checks; service tests verify notification effect deduplication.
