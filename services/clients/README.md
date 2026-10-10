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
source,customFields,emailOptIn,whatsappOptIn,createdAt,updatedAt,revision,portalProtected}`. Create requires displayName or a first/last name.
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
`duplicateMode` remains accepted for compatibility, but matching identities require
explicit review decisions. An existing email or normalized name produces `review`,
never an automatic student update. `decisions` contains
`{rowNumber,action:'create'|'update'|'skip',clientId?}`; only update requires a
clientId. A create decision intentionally keeps a separate student, including
siblings sharing an email. Complete names can create without email. Exact repeated
name/email/phone/kind rows within the file are skipped unless explicitly reviewed.
Preview rows are `{rowNumber,action,clientId?,contact?,errors,message?,candidates?}`.
Candidates contain `{id,displayName,email,kind,reasons}` and summary includes
`review` alongside created/updated/skipped/errors. Commit rejects unresolved review
rows and re-evaluates all decisions under the tenant mutation lock. Decisions are
part of the persistent idempotency digest. Existing selected aliases must be
refreshed to their canonical IDs before an import update.

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
ID. Existing mappings are the only automatic identity match. A new external ID
creates a separate student even when an email or name resembles an existing one;
manual duplicate review offers merge/dismissal afterward. Connectors fill empty
fields on established identities, preserving local edits, display names, status
and tags. Shared family addresses remain valid. Source mapping retains both the
current canonical `client_id` and its `original_client_id` through a merge.
Each delivery emits
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

## Canonical student identity and contact API

Migration 005 preserves every client UUID and original email/phone column. It
backfills one related contact per legacy record and existing payer relationships.
A contact can link to several students, with up to 20 emails and 20 phones per
contact. Addresses are unique only inside a contact; student emails are not unique.
All new tenant tables force RLS. The migration temporarily releases FORCE for the
owning migration role's existing-table backfill and restores it before commit.

Related contact shape:
`{id,displayName,relationship,isPrimary,emails:[{id,value,label,isPrimary}],phones:[{id,value,label,isPrimary}]}`.
Relationships are student/parent/guardian/sponsor/self/other. Own student contacts
use student. Primary addresses are contact-wide; primary contact is per student.

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/v1/clients/:id/contacts` | `{items:relatedContact[]}` |
| POST | `/v1/clients/:id/contacts` | `{contactId?,displayName?,relationship?,isPrimary?,emails?,phones?}`; `{item:relatedContact}` |
| PATCH | `/v1/clients/:id/contacts/:contactId` | Same editable fields, without contactId; `{item:relatedContact}` |
| DELETE | `/v1/clients/:id/contacts/:contactId` | Detach only; `{item:{studentId,contactId,detached:true}}` |
| GET | `/v1/duplicates` | `limit`/`offset`; `{items:[{source:client,target:client,reasons:string[]}],total,limit,offset}` |
| POST | `/v1/duplicates/dismiss` | `{sourceId,targetId}`; `{item:{sourceId,targetId,dismissed:true}}` |
| POST | `/v1/merges/preview` | `{sourceId,targetId}`; `{item:{source,target,conflicts:[{field,source,target}],contactAddresses:{email:[{value,label}],phone:[{value,label}]},primaryAddresses:{email?,phone?},sourceContacts,targetContacts,consolidatedContactIds,affectedLinks:{contacts,payers,sourceIdentities,groups},blockedReasons,sourceRevision,targetRevision}}` |
| POST | `/v1/merges` | `{sourceId,targetId,sourceRevision,targetRevision,fieldChoices:{[field]:'source'|'target'},primaryAddresses?:{email?,phone?}}`; `{item:client,merge:{id,sourceId,targetId,revision}}` |

New contacts require displayName; contactId links an existing tenant contact.
An explicitly supplied emails/phones array replaces that contact's addresses,
including when it is shared among students. Address values are `{value,label?,isPrimary?}`.
Omitted arrays retain existing addresses; `[]` clears them. Changes to a legacy
record's own contact synchronize its legacy displayName/email/phone. Legacy CRM
edits preserve historical addresses and select the updated address as primary.
Scoped staff can edit a shared contact only when all linked students are in scope.

Candidate matching uses Unicode NFKC, whitespace and case normalization while
preserving display values. Shared email candidates may be siblings. Dismissal
records a tenant-scoped pair and actor. Merges require clients.merge in addition
to staff role restrictions; each field conflict requires an explicit decision.
Custom field choices use `custom:<UUID>`. Nonconflicting populated values survive,
tags are unioned, and contact/payer/source links move to the survivor. Existing
survivor relationships win when the same contact or payer is linked twice.
Revision changes reject stale previews. More than 30 merged tags or 100 custom
fields requires reducing values before commit.

Email and phone are collections, not mutually exclusive field conflicts. A merge
unions the addresses on both students' own contacts into the survivor's own
contact, including student/self contacts retained from earlier merges. Legacy
email/phone values are included even when their contact link was detached.
`primaryAddresses` selects an existing retained address; omission defaults to the
survivor's current value, then the source's value, then the first retained address.
The selection updates the legacy email/phone projection used for default delivery.
It does not discard additional addresses. Email identity trims whitespace and
ignores case, but does not strip dots or plus tags. Phone identity uses the existing
phone normalizer. Identical normalized addresses are stored once, keeping existing
survivor labels; more than 20 distinct addresses per kind blocks the merge.

Only links to the consolidated own contacts are removed from the survivor.
Original contact records and their other student relationships remain intact;
family, payer and other independently linked contacts retain their own addresses.
Scoped staff must have access to every student sharing the survivor's own contact.
The transaction, tenant lock, stale-preview checks and portal-access protections
also cover address consolidation. The audit snapshots include pre-merge contact
details and the chosen primary values. Older clients' email/phone field choices
are accepted as primary selections while retaining all addresses.

The source record remains a tombstone with merged_into/merged_at, its original
fields and revision. Ordinary GET/PATCH resolves aliases; lists and recipients
exclude tombstones. A retained audit contains actor, both pre-merge snapshots,
choices and survivor revision. Alias chains are flattened. Tombstones, survivors
with aliases and portal protected students cannot be deleted. Issued invoice
snapshots remain the Billing service's authority. Merge emits transactional
`clients.student-merged.v1` `{sourceId,targetId,revision}`; consumers repoint their
own references idempotently. Contact edits emit `clients.contacts-updated.v1`
`{clientId,revision}` for every student sharing the changed contact.

### Private portal validation

POST `/internal/portal-students` accepts `{businessId,studentId,protect:boolean}`
with constant-time-checked `x-portal-internal-secret` against
`PORTAL_INTERNAL_SECRET`. The public gateway never exposes this route. It returns
`{item:{id,displayName,revision,portalProtected,contacts:relatedContact[]}}`.
Protect=true locks the same tenant mutation lock as merge, rejects aliases,
nonstudents and inactive students, then permanently protects the student before
Platform issues an invitation or grant. Merge rejects either protected student.
There is no automatic unlock from events or revocation; a future explicit reviewed
unlock workflow is required. Protect=false canonicalizes an alias for trusted reads.
Missing configuration returns unavailable, and invalid secret returns forbidden.
Student/parent presentation routes remain a later phase.

## Groups and scoped student directory (Phase 2)

Group shape is `{id,name,description,revision,studentCount,createdAt,updatedAt}`.
Name is 1–160 characters; description is null or at most 2,000 characters.
Groups have many-to-many student membership and do not own student records.

| Method | Path | Request / response |
| --- | --- | --- |
| GET | `/v1/groups` | `limit`/`offset`; `{items:Group[],total,limit,offset}` |
| POST | `/v1/groups` | `{name,description?}`; `{item:Group}` |
| GET | `/v1/groups/:id` | `{item:Group}` |
| PATCH | `/v1/groups/:id` | `{name?,description?}`; `{item:Group}` |
| DELETE | `/v1/groups/:id` | `{item:{id,deleted:true}}`; students retained |
| GET | `/v1/groups/:id/members` | `limit`/`offset`; `{items:Client[],total,limit,offset}` |
| POST | `/v1/groups/:id/members` | `{studentIds:UUID[]}`; `{item:Group,studentIds:changedIds}` |
| DELETE | `/v1/groups/:id/members` | Same body and response; detaches only |
| GET | `/v1/portal/students` | `limit`/`offset`; `{items:PortalStudent[],total,limit,offset}` |
| GET | `/v1/portal/students/:id` | `{item:PortalStudent}` |

Lists default to 50, max 100; membership mutation accepts 1–500 UUIDs. Duplicate
IDs and already-applied changes are idempotent: only actual changes increment the
group revision or emit events. IDs are canonicalized before adding/removing.
Membership changes invalidate the student's merge preview revision. A merge moves
source group memberships to the survivor and emits removals/additions per affected
group. Deleting a student emits group removals; deleting a group never deletes a
student. Group create/edit/delete events carry `{groupId,revision}`; membership
events `clients.group-members-added.v1` and `clients.group-members-removed.v1`
carry `{groupId,studentIds,revision}`. These events contain no contact data.

Group writes require clients.groups.manage plus a staff role and business scope.
Group reads require clients.read and a staff role. Scoped staff list/count only
granted students and their groups; member lists exclude all other students.
Student and parent roles use the safe directory, not staff group member routes.
Group membership does not create access grants or deliver invitations. Only an
explicit Platform invitation action can request delivery.

Existing `/v1/clients` and recipient filter objects gain `groupId:UUID` and
`unassigned:'true'|'false'`, composed with existing custom filters/sort/pagination.
Unassigned means no group membership in this business. Combining groupId with
unassigned=true deliberately yields no matching students.

Client create/PATCH accepts `photo:string|null`, and staff client/list/member
responses include it. Only PNG/JPEG/WebP inline data URLs pass validation; decoded
bytes must be at most 256 KiB with matching file signatures. SVG, arbitrary URLs,
malformed base64 and larger photos are rejected. Existing photos default to null.
Photo conflicts appear as field `photo` in merge previews and require a choice.

`PortalStudent` is exactly
`{id,firstName,lastName,displayName,photo,revision,contacts:RelatedContact[]}`.
It excludes notes, consent, tags, source, staff custom fields, payer CRM details,
portal protection and internal source mappings. Lists filter exact signed
studentIds for student/parent or student scope, and detail rechecks both requested
and canonical IDs. Business-scoped staff may read the safe directory. Client
custom fields remain staff-private until an explicit sharing policy exists.
