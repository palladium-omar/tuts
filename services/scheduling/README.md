# Scheduling service

Independent NestJS process on port 4003 with its own PostgreSQL database. Requires `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` and the `scheduling` entitlement in the gateway-issued context. Owner, admin and tutor roles can use these endpoints. The signed business context is authoritative; tenant fields in request bodies are rejected.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/v1/sessions` | `{items}` bounded to 100 by default, max 200; optional clientId/status/limit |
| POST | `/v1/sessions` | Create a one-on-one session |
| PATCH | `/v1/sessions/:id` | Edit a scheduled session |
| POST | `/v1/sessions/:id/cancel` | Cancel; repeating cancellation returns current item |
| POST | `/v1/sessions/:id/complete` | Complete; repeated completion emits no duplicate event |

Creation example:

```json
{"clientId":"11111111-1111-4111-8111-111111111111","title":"SAT Math","subject":"Math","startsAt":"2026-12-01T10:00:00.000Z","endsAt":"2026-12-01T11:00:00.000Z"}
```

Responses use `{item}` with `id`, `businessId`, `clientId`, `assignedTutorId`, `title`, `subject`, UTC `startsAt`/`endsAt`, `status`, `createdAt`, `updatedAt`. Subject defaults to General. assignedTutorId defaults to the authenticated staff member's opaque user ID; explicit null leaves the session unassigned. Assigning another user returns 403 until a verified membership lookup is implemented.

PostgreSQL exclusion constraints prevent overlapping scheduled sessions for either the same student or tutor within a business. Ranges are half open, so consecutive sessions are allowed. A transaction advisory lock serializes scheduling mutations within each business and prevents conflicting create/update lock ordering. Completed/cancelled sessions release the active slot. Migration requires the trusted `btree_gist` extension and a role that can install it in this service's database.

Creation emits `scheduling.session-created.v1`; completion emits `scheduling.session-completed.v1`, each atomically with the session mutation. Client IDs are opaque foreign-service references; this module does not query another database or claim client existence. No billing price/payer snapshot is emitted because automatic billing is not configured.

Recurring schedules, business timezone recurrence expansion, group sessions and tutor directory assignment are pending. Dates currently require ISO 8601 UTC with Z.

Run `pnpm --filter @palladium/scheduling typecheck`, `build`, or `test`. Integration tests additionally require `SCHEDULING_TEST_DATABASE_URL` pointing to an isolated service database with a non-superuser role without BYPASSRLS. They migrate the schema and use synthetic temporary tenant data.
