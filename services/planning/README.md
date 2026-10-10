# Planning

Independent Nest/PostgreSQL service, port **4009**, entitlement `planning`.
Node and Worker adapters share the same domain behavior. Every service-owned
table forces business tenant RLS. Run the additive migration through the existing
deployment tooling; no other service database is queried.

## Authorization and sharing

Every endpoint requires verified gateway context. Reads require `planning.read`;
writes require `planning.write`. Creating a board or instantiating a template also
requires `clients.read` and the `clients` entitlement: Planning validates the
student through signed `GET /v1/portal/students/:id` on Clients. Configure a
`CLIENTS` Worker binding or `CLIENTS_URL` in Node. Unavailable validation fails
with 503. The service never accepts an unverified browser tenant header.

Each board has one student and explicit sharing:

- `private`: creator and business-wide owner/admin only, additionally subject to
  the student resource grant.
- `student`: every actor with the student resource grant and required Planning
  capability can read the board and edit its cards.
- Only the creator or business-wide owner/admin can rename/archive a board,
  change sharing, edit columns or apply a template revision. Restricted admins
  receive no ownership bypass. Students and guardians may create their own boards.

This service stores workflow state in columns. Moving a card to Done, checking a
checklist item or linking an assignment **does not submit or approve homework**.
Learning owns assignment status, resource access and downloads. An opaque Learning
reference grants no additional Learning access. Google Docs links retain Google's
sharing controls. Planning does not fetch arbitrary links or document contents.

All responses have `Cache-Control: no-store`. JSON input is strict and bounded.
HTTPS URLs reject credentials, explicit ports, literal IPs and local/internal
names. Google Docs references accept explicit `docs.google.com/document/d/...`
URLs. Render user strings as text and open links with normal external-link safety.

## API contracts

API paths below are inside the gateway's `planning` prefix. IDs are UUIDs.
`revision` fields are positive integers. Stale expected revisions return 409;
refresh the board before retrying. Positions are finite numbers from -1e9 to 1e9,
sorted ascending, then by UUID for ties. The parent board is locked before every
mutation. Every card mutation also advances the board revision.

### Boards

| Method/path | Input | Response |
| --- | --- | --- |
| GET `/v1/boards` | `?studentId=&limit=50&offset=0` (student optional, limit max100) | `{items,total,limit,offset}` |
| POST `/v1/boards` | `{studentId,name,description?,sharing?}` | board detail; default private, three initial columns |
| GET `/v1/boards/:id` | | board detail |
| PATCH `/v1/boards/:id` | `{expectedRevision,name?,description?,sharing?}` | `{item:Board}` |
| DELETE `/v1/boards/:id` | JSON `{expectedRevision}` | `{item:Board}` with `archivedAt`; cards archived atomically |

`Board = {id,studentId,name,description,sharing,createdBy,revision,templateKey,
templateVersion,applicability,archivedAt,createdAt,updatedAt}`.
`board detail = {item:Board,columns:Column[],cards:Card[],canManageStructure}`.
There may be multiple boards per student. Detail returns all active cards (max500)
and columns (max30). Board and card DELETE archives records; there is no implicit
delete of students, Learning assignments or documents.

### Columns

| Method/path | JSON input | Response |
| --- | --- | --- |
| POST `/v1/boards/:id/columns` | `{expectedBoardRevision,name,position}` | `{item:Column,board:Board}` |
| PATCH `/v1/boards/:id/columns/:columnId` | `{expectedBoardRevision,expectedRevision,name?,position?}` | `{item:Column,board:Board}` |
| DELETE `/v1/boards/:id/columns/:columnId` | `{expectedBoardRevision,expectedRevision,moveCardsToColumnId?}` | `{deletedId,board:Board,cards:movedActiveCards}` |

`Column = {id,boardId,name,position,revision,createdAt,updatedAt}`.
Keep at least one column. A column containing any cards, including archived cards,
requires another column on the same board as its destination; cards are moved
transactionally before column removal. Deleting a column never discards cards.

### Cards

| Method/path | JSON input/query | Response |
| --- | --- | --- |
| GET `/v1/boards/:id/cards` | `?limit=50&offset=0` (max100, optional matching studentId) | `{items,boardRevision,total,limit,offset}` |
| POST `/v1/boards/:id/cards` | `{expectedBoardRevision,columnId,position,title,description?,checklist?,references?,deadline?,learningAssignmentId?}` | `{item:Card,board:Board}` |
| GET `/v1/cards/:id` | | `{item:Card,board:Board}` |
| PATCH `/v1/cards/:id` | `{expectedRevision,title?,description?,checklist?,references?,deadline?,learningAssignmentId?}` | `{item:Card,board:Board}` |
| POST `/v1/cards/:id/move` | `{expectedRevision,expectedBoardRevision,columnId,position}` | `{item:Card,board:Board}` |
| DELETE `/v1/cards/:id` | `{expectedRevision}` | `{item:Card,board:Board}` with `archivedAt` |

`Card = {id,boardId,columnId,title,description,position,checklist,references,
deadline,deadlineEdited,learningAssignmentId,templateCardKey,createdBy,revision,
archivedAt,createdAt,updatedAt}`. Moves stay inside one board.

Checklist: `[{id:UUID,text:string,done:boolean}]`, up to100 unique IDs, text max500.
References: up to30 entries, each one of:

```json
{"kind":"link","label":"Official course page","url":"https://example.org/course"}
{"kind":"google_doc","label":"Essay draft","url":"https://docs.google.com/document/d/DOCUMENT_ID/edit"}
{"kind":"learning_resource","label":"Worksheet","resourceId":"UUID"}
```

Name/title max200, description max10000. References contain no provider tokens,
embedded document contents or authority to download the referenced resource.

### Deadlines

Card create/PATCH accepts `deadline: null` or:

```json
{
  "kind": "official",
  "dueAt": "2027-01-13T18:00:00Z",
  "timeZone": "Europe/London",
  "sourceUrls": ["https://www.ucas.com/applying/applying-to-university/dates-and-deadlines-for-uni-applications"],
  "cycle": 2027,
  "round": "equal_consideration",
  "applicability": "Confirm the individual course deadline."
}
```

`kind` is official/personal; `dueAt` is an ISO datetime with explicit offset or
null; timezone must be an IANA zone. Official dates require a source link.
The response additionally contains `status: verified|requires_confirmation|user_set`
and `verifiedAt: ISO|null`. Only the reviewed built-in template can set verified.
A supplied official date remains requires_confirmation; a supplied personal date
is user_set. No date supplied is requires_confirmation. Editing or clearing a
template date sets `deadlineEdited=true`, preventing template updates from
replacing it. Datepicker/UI must retain the distinction between official and
personal milestones and the visible verification state.

### Templates

Templates are immutable versioned tenant records. First use seeds built-in
versions with `ON CONFLICT DO NOTHING`; a source update must publish a higher
version. System templates cannot be overwritten through the API.

| Method/path | Input | Response |
| --- | --- | --- |
| GET `/v1/templates` | `?cycle=2027` | `{items:[Template],cycle}` (bounded200 latest versions) |
| GET `/v1/templates/:key` | `?version=1` optional; latest otherwise | `{item:Template}` |
| POST `/v1/templates/:key/instantiate` | below | board detail plus `{replayed:boolean}` |
| POST `/v1/templates` | custom definition below; staff role only | `{item:Template}` with next immutable version |
| GET `/v1/boards/:id/template-review` | `?version=2` | `{board,templateVersion,suggestions,addedCards,automaticApply:false}` |
| POST `/v1/boards/:id/template-apply` | `{version,expectedRevision,cardIds:UUID[]}` | `{board,cards,preservedCardIds}` |

`Template = {key,version,name,system,definition,createdAt}`.
Definition includes `key,version,name,cycle,country,applicantCountries,
applicantCategory,program,round,applicability,sourceUrls,verifiedAt,columns,cards`.
Country is destination ISO2; applicantCountries is empty or an explicit origin
country constraint. Columns are names; cards have a stable `key`, `columnIndex`
and the ordinary card fields, with response deadline metadata.

Instantiation requires an explicit template choice and scope confirmation:

```json
{
  "studentId": "UUID",
  "version": 1,
  "name": "My UCAS plan",
  "sharing": "student",
  "idempotencyKey": "fresh-random-key-at-least-8-characters",
  "applicabilityConfirmed": true,
  "applicability": {
    "cycle": 2027,
    "country": "GB",
    "applicantCategory": "undergraduate",
    "program": "undergraduate_standard",
    "round": "equal_consideration"
  }
}
```

Use definition values for scope selections. For Morocco add `applicantCountry:
"MA"`. All exact scope fields must match the template and its applicant country
constraint. This acknowledges applicability; it is not automatic eligibility
determination. Reusing the same key and body returns the original board; a
different body with the same key returns409. Archived originals are not silently
recreated. A deliberate new board uses a new key.

Staff can publish a custom definition with `key` beginning `custom-`, name,
cycle, country, applicantCountries optional, applicantCategory, program, round,
applicability, sourceUrls optional, columns (1–30 names), and cards (max200 ordinary
create-card fields plus stable key and columnIndex; no expected revision,
position or columnId). Every publish creates the next version. Submitted dates
are unverified/personal; clients cannot assert `verifiedAt` or verified status.

Template review never overwrites a board automatically. Suggestions expose the
current/proposed date, templateCardKey, cardId, expectedRevision and
preserveUserEdit. Apply only changes dates on selected, unedited template cards;
other card fields and custom cards remain intact. User-edited dates are returned
in preservedCardIds. Added template cards are suggestions for manual creation.
Older versions cannot roll a board back. New country/program/round applicability
requires a new board rather than silently reclassifying existing work.

## 2027 source review

Official sources checked **2026-10-10 UTC**; stored timestamps and applicability
are part of each definition/deadline. Publication of these templates is not a
promise that an institution's dates or requirements cannot change.

| Key | Verified date | Applicability/source |
| --- | --- | --- |
| `ucas-2027-standard` | 13 Jan2027,18:00 Europe/London | Standard undergraduate equal consideration, excluding October courses; [official UCAS event](https://www.ucas.com/events/2027-entry-deadline-for-all-undergraduate-courses-except-those-with-a-15-october-deadline-475546) |
| `ucas-2027-early` | 15 Oct2026,18:00 Europe/London | Oxford/Cambridge and most medicine/dentistry/veterinary courses; confirm chosen course, [official 2027 calendar](https://www.ucas.com/applying/applying-to-university/dates-and-deadlines-for-uni-applications) |
| `common-app-2027` | No universal submission date | 2026–27 season confirmed; institution/round/timezone require confirmation, [official cycle announcement](https://www.commonapp.org/blog/common-app-opens-application-launch-2026-27-season/) |
| `bocconi-2027-winter-international` | 26 Jan2027,15:00 Europe/Rome | International standard Bachelor/Law Winter; excludes separate WBB/HEC procedures, [official international admissions](https://www.unibocconi.it/en/applying-bocconi/bachelor-and-law-programs/application-and-admissions/admissions) |
| `bocconi-2027-early-international` | 29 Sep2026,15:00 Europe/Rome; already closed | Historical tracking only, same official source |
| `campus-france-maroc-2027` | 15 Nov2026,23:59 Africa/Casablanca | Morocco 2026/27 application procedure for2027 entry, listed connected/DAP programs only; [official Morocco calendar](https://www.maroc.campusfrance.org/calendrier-de-la-procedure-de-candidature-20262027) |

No generic university admission deadline, inferred interview deadline, result
release date or personal preparation deadline is manufactured. The source's
current applicant category, individual course, country/procedure and admissions
round control applicability. Each unspecified deadline stays visibly unverified.

## Events and merges

Mutations write events in the same tenant transaction as state:

- `planning.board-updated.v1`: boardId, studentId, revision, sharing, archived,
  updatedAt.
- `planning.card-updated.v1`: cardId, boardId, studentId, revision, columnId,
  sharing, archived, learningAssignmentId, updatedAt.
- `planning.template-published.v1`: templateKey, version.

No invitation tokens, essays, notes, titles, checklist text or document URLs are
published. Consumers must honor revision and board sharing when producing read
models; private records are not made public by events.

Subscribe Planning centrally to `clients.student-merged.v1`. The consumer verifies
the producer, uses inbox deduplication, ignores stale source revisions, rejects
cycles, persists tenant aliases and updates board student references/revisions
under parent locks. Board IDs, card IDs, creator and sharing are preserved.
The canonical student ID is always checked against the current signed grant:
an old source grant cannot authorize the merge target. No access grant transfers.

## Build checkpoint and limitations

`pnpm --filter @palladium/planning build` passed. No tests were added/run, migrations
applied or provider actions performed. Root owns dependency installation, service
registry, queue wiring and deployment. Multiple boards, card/column changes and
source-backed dates are implemented independently of provider credentials.
Arbitrary link previews, external document creation, provider deadline monitoring
and automatic homework completion are not advertised capabilities.
