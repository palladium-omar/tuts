# Clients service

Port `4002`; service-owned PostgreSQL database. All business endpoints require a
verified gateway context with the `clients` entitlement and owner/admin/tutor
role. Parent/student portal access is not implemented and these roles are denied.
Every domain SQL operation runs inside `Database.withTenant`, with forced RLS.

Gateway external prefix is `/api/clients`.

| Method | Path | Request / response |
| --- | --- | --- |
| GET | `/v1/clients` | Optional `kind`, `limit` (1–100, default 50), `offset`; `{items:[client]}` |
| POST | `/v1/clients` | `{displayName,kind?:student or payer,email?,phone?,notes?}`; `{item:client}` |
| GET | `/v1/clients/:id` | `{item:client}` or tenant-scoped 404 |
| PATCH | `/v1/clients/:id` | Partial displayName/email/phone/notes; `{item:client}` |
| GET | `/v1/clients/:id/payers` | Student's `{items:[{studentId,payerId,relationship,payer}]}` (max 100) |
| POST | `/v1/clients/:id/payers` | `{payerId,relationship?:parent or guardian or sponsor or self or other}`; upserts `{item:relationship}` |

Client shape: `{id,kind,displayName,email,phone,notes,createdAt,updatedAt}`. Email,
phone and notes can be cleared with null. Kind is immutable. A payer is a distinct
record, so a parent can pay for several students. Composite foreign keys prevent
cross-business relationships. Missing foreign business IDs return 404.

Writes persist events in the same transaction: `clients.client-created.v1` carries
only `{clientId}`; updates use `clients.client-updated.v1`, relationship writes use
`clients.payer-linked.v1`. Events exclude contact data. Broker retry/deduplication
is provided by service-kit. Ordinary record creation does not implement financial
idempotency keys; clients are identified by server-generated UUIDs.

`pnpm --filter @palladium/clients typecheck` and
`pnpm --filter @palladium/clients test`. Controller tests use a bounded database double to cover tenant selection,
outbox callback failure, absent-resource handling and input validation.
Root integration verifies signed context/role/entitlement rejection and PostgreSQL
RLS with two tenant contexts. No import/contact delivery, archival or portal
resource relationship authorization is implemented.

Optional real database RLS tests run when `CLIENTS_TEST_DATABASE_URL` points to the
already-migrated service database using its non-superuser runtime role. They use
synthetic fixtures inside a rolled-back transaction and skip without that variable.
