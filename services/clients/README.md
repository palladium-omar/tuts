# Clients CRM service

Port `4002`, gateway prefix `/api/clients`, service-owned PostgreSQL database.
Every endpoint requires verified gateway membership, the `clients` entitlement,
and an owner/admin/tutor role. Delete and custom-field creation/editing additionally require owner/admin. Domain
SQL uses a tenant transaction and forced RLS. Student/parent portal access remains
unavailable.

| Method | Path                     | Request / response                                                                                                                                                                         |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/v1/clients`            | Optional `kind`, `status`, `search`, `tag`, `source`, `hasEmail`, `hasPhone`, `sortBy`, `sortDirection`, `filters` and `limit` (1–100, default 50), `offset`; `{items,total,limit,offset}` |
| GET    | `/v1/fields`             | `{items:[{id,key,label,type,options?,createdAt}]}`                                                                                                                                         |
| POST   | `/v1/fields`             | Owner/admin; `{label,type,options?}`; `{item:field}`                                                                                                                                       |
| PATCH  | `/v1/fields/:id`         | Owner/admin; `{label?,options?}`; key/type immutable                                                                                                                                       |
| POST   | `/v1/recipients`         | Exactly one of `{clientIds:[uuid]}` or `{filter:{...listFilters}}`; `{items,total,truncated}`                                                                                              |
| POST   | `/v1/clients`            | Editable contact properties; `{item:client}`                                                                                                                                               |
| GET    | `/v1/clients/:id`        | `{item:client}` or tenant-scoped 404                                                                                                                                                       |
| PATCH  | `/v1/clients/:id`        | Partial editable properties; `{item:client}`                                                                                                                                               |
| DELETE | `/v1/clients/:id`        | Owner/admin; `{item:{id,deleted:true}}`                                                                                                                                                    |
| GET    | `/v1/clients/:id/payers` | `{items:[{studentId,payerId,relationship,payer}]}` (max 100)                                                                                                                               |
| POST   | `/v1/clients/:id/payers` | `{payerId,relationship?:parent or guardian or sponsor or self or other}`                                                                                                                   |
| POST   | `/v1/imports/parse`      | Multipart `file`; `{item:{headers,rows,totalRows}}`                                                                                                                                        |
| POST   | `/v1/imports/preview`    | `{rows,mapping,duplicateMode}`; `{item:{rows,summary}}`                                                                                                                                    |
| POST   | `/v1/imports/commit`     | Same body plus `Idempotency-Key` header; `{item:{created,updated,skipped,errors,skippedRows}}`                                                                                             |

Client shape: `{id,kind,firstName,lastName,displayName,email,phone,notes,status,tags,
source,customFields,emailOptIn,whatsappOptIn,createdAt,updatedAt}`. Create requires displayName or a first/last name.
`kind` defaults to `student` and is immutable; `status` is lead/active/inactive,
defaulting to lead for new contacts. Existing contacts retain all data and migrate
to active. First/last names default to empty strings; existing display names are
preserved without guessing a split. Editing names composes displayName unless
explicitly supplied. Email, phone, notes and source can be cleared with null;
names can be cleared with empty strings and tags with `[]`.

Search matches literal substrings in names, email, phone and tags. Tenant totals
are counted independently of the selected pagination window. Ordinary manual
creation permits shared email addresses; imports report ambiguous existing
matches instead of selecting one arbitrarily.

## Mapped imports

CSV accepts comma, semicolon or tab delimiters, quoted cells and a UTF-8 BOM.
XLSX reads the first worksheet; `.xls`, macro/encrypted workbooks and embedded
objects are rejected. Limits: 5 MB uploaded, 20 MB expanded workbook archive,
2,000 data rows, 100 columns, 4,000 characters per cell. Headers must be unique.
ZIP entries are expanded under explicit byte limits before ExcelJS parses them;
large sparse workbook dimensions and unsupported XML declarations are rejected.
No cell formula is executed; cached formula results can be read.

`mapping` is an object of contact field to file header, such as
`{"firstName":"First name","lastName":"Surname","email":"Email","tags":"Labels"}`.
Supported fields are firstName, lastName, displayName, email, phone, notes,
status, tags, kind, source, emailOptIn and whatsappOptIn. Custom columns use `custom:<fieldId>` keys. Numbers, ISO dates, select values and booleans are validated against this tenant's definitions; boolean/consent file cells accept true/false, yes/no or 1/0. Tags in files accept comma/semicolon/pipe separators.
`duplicateMode` defaults to `skip`; `update` explicitly permits replacing mapped
nonblank fields on an email match. Unmapped and blank values never overwrite
contact properties. Name-only updates recompose the display name.

Preview rows are `{rowNumber,action,clientId?,contact?,errors,message?}`, where
action is create/update/skip/error. Row numbers include the file header (first data
row is 2). Summary is `{created,updated,skipped,errors}` with error row count.
Missing email rows skip with an explanation, repeated file emails use the first
valid row, and multiple CRM matches are errors. Missing names are an error only
for a new contact. Commit re-evaluates matches within a serialized tenant mutation
transaction and applies valid rows atomically with outbox events. Per-row errors
are returned as `{rowNumber,messages}` and skips as `{rowNumber,message}`.

Use one stable `Idempotency-Key` (1–160 printable characters) per import attempt.
Its tenant-scoped digest and result persist in the same transaction as contacts.
The same key and content returns the original result; changed content returns 409. Create/PATCH/delete, import commits and connector intake serialize email
matching under the same tenant advisory lock. A new key remains a new import;
choose skip mode for repeat files or update mode deliberately.

## Connected source intake

`integrations.contacts-received.v1` contains
`{connectionId,source,contacts:[{externalId,firstName?,lastName?,displayName?,email?,
phone?,notes?,status?,tags?}]}`. Each event contains at most 200 contacts.
Service-kit inbox deduplication and the mutation/outbox transaction handle broker
retries. `integrations.connection-disconnected.v1` persists a tenant-scoped source
tombstone under the same connection advisory lock used by contact intake. Any
contact event processed after that disconnect is ignored, including delayed or
retried batches. Existing imported CRM contacts and source links are retained; a
new connection UUID is required to reconnect. RLS scopes durable external mappings by business, connection and external
ID. Existing mappings win; otherwise normalized email can link a single existing
contact. Email ambiguity or malformed rows produce issues. Source contacts with
stable external IDs can be created without an email.

Connectors fill empty fields only, preserving local edits, display names, existing
status and nonempty tags. New source contacts default to student/lead. A nonblank
existing email is preserved when the source changes its email. Filling a blank
email is rejected if it would introduce a duplicate. Each delivery emits
`clients.source-synced.v1` with `{connectionId,created,updated,skipped,errors,
issues:[{externalId,reason}]}` for the integrations service to record its outcome.

## Custom fields, filters and recipient resolution

Businesses can define up to 100 fields of type text, number, date, select or boolean.
Select definitions require 1–100 unique options. Used options cannot be removed
while contacts reference them. Fields have immutable generated keys and UUID IDs;
`customFields` values are keyed by ID. POST/PATCH validate values against current
tenant definitions; PATCH merges supplied custom values, and null clears one value.
Existing data remains intact. Consent flags default to false for migrated and new
contacts. Connector intake never accepts or changes custom values/consent.

List `hasEmail`/`hasPhone` accept string `true` or `false`; tag and source are exact
matches. `sortBy` is displayName, createdAt, status or `custom:<fieldId>`;
`sortDirection` is asc/desc (default createdAt desc). Null sort values appear last.
`filters` is a JSON array of at most 20 `{field,operator,value?}` clauses combined
with AND. Builtin fields: displayName, firstName, lastName, email, phone, status,
kind, source, tags, createdAt, emailOptIn, whatsappOptIn; custom fields use
`custom:<fieldId>`. Operators: contains (text only), equals, gt/lt (number/date),
is_empty and is_not_empty. Values must match the field type. Text matching treats
SQL wildcards literally. Blank text and null are empty; false and zero are values.

Recipient resolution uses the same filters without pagination. It requires either
1–2,000 client IDs or a filter object (an empty filter deliberately means all
contacts). Response items expose id, displayName, firstName, lastName, email, phone,
emailOptIn, whatsappOptIn and customFields. Only this business is visible; at most
2,000 items are returned and `total`/`truncated` identify a larger matching set.
Recipient resolution is staff-only under the clients entitlement; services call
it via HTTP with the caller's verified gateway authorization.

Client mutations emit transactional `clients.client-created.v1`,
`clients.client-updated.v1`, `clients.client-deleted.v1`, or
`clients.payer-linked.v1` with identifiers. Created/updated payloads also include current emailOptIn and whatsappOptIn flags; names, addresses and other contact properties remain absent. Delete
removes local payer/source links; other services keep their own historical data.

Checks: `pnpm --filter @palladium/clients build` and `pnpm --filter @palladium/clients test`. PostgreSQL RLS integration checks require `CLIENTS_TEST_DATABASE_URL` pointing to an already-migrated database with a non-superuser runtime role; fixture writes are rolled back.


## Cloudflare runtime

`src/worker.ts` exports this domain as an independent Worker through the shared Nest runtime; `src/main.ts` remains the Node entrypoint. The service retains its own PostgreSQL database, signed caller context, tenant RLS and event contracts. Migrations are applied during deployment, outside requests. Worker secrets and bindings are supplied by the deployment configuration.
