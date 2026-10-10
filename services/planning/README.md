# Planning

> Current cross-service context: [system](../../docs/architecture/system.md), [API/schema inventory](../../docs/service-inventory.md), [security/performance audit](../../docs/reviews/2026-10-10-platform-audit.md). Service descriptions below define APIs and local behavior; provider/configuration readiness is separate.

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
Suggested template preparation dates use `kind: personal`,
`status: requires_confirmation` and `verifiedAt: null`; their applicability
explains that they are planning targets. They do not mean the student has agreed
that date. Suggested reminders use noon UTC as a calendar marker, not an
institution's submission cutoff or a test center appointment time.
A supplied official date remains requires_confirmation; a supplied personal date
is user_set. No date supplied is requires_confirmation. Editing or clearing a
template date sets `deadlineEdited=true`, preventing template updates from
replacing it. Datepicker/UI must retain the distinction between official and
personal milestones and the visible verification state.

### Templates

Templates are immutable versioned tenant records. First use seeds built-in
versions with one tenant-scoped batch `INSERT ... ON CONFLICT DO NOTHING`; a source
update must publish a higher version. System templates cannot be overwritten
through the API. The six original 2027 version-1 definitions are preserved; the
dated release uses version 2 and the same template/card keys.

| Method/path | Input | Response |
| --- | --- | --- |
| GET `/v1/templates` | `?cycle=2027` (entry year, 2027–2200) | `{items:[Template],cycle}` (bounded200 latest versions) |
| GET `/v1/templates/:key` | `?version=1` optional; latest otherwise | `{item:Template}` |
| POST `/v1/templates/:key/instantiate` | below | board detail plus `{replayed:boolean}` |
| POST `/v1/templates` | custom definition below; staff role only | `{item:Template}` with next immutable version |
| GET `/v1/boards/:id/template-review` | `?version=2` | `{board,templateVersion,suggestions,addedCards,automaticApply:false}` |
| POST `/v1/boards/:id/template-apply` | `{version,expectedRevision,cardIds:UUID[],addedCardKeys?:string[]}` | `{board,cards,addedCards,alreadyPresentCardKeys,preservedCardIds}` |

`Template = {key,version,name,system,definition,createdAt}`.
Definition includes `key,version,name,cycle,country,applicantCountries,
applicantCategory,program,round,applicability,sourceUrls,verifiedAt,columns,cards`.
Country is destination ISO2; applicantCountries is empty or an explicit origin
country constraint. Columns are names; cards have a stable `key`, `columnIndex`
and the ordinary card fields, with response deadline metadata.

Built-in releases cover entry cycles 2027–2031. A request for a later supported
cycle generates the same six template families with dated suggested preparation
milestones and persists them as immutable version 1. Direct detail/instantiate
requests for those system keys also seed the matching cycle. This generation
never copies a 2027 verified date into a future official deadline. Future dates
all require confirmation, even where a provider has announced an anticipated
calendar. Each future source URL is a place to check, not proof of that date.

Clients owns the student's planning profile; Planning does not infer a grade or
cycle from identity fields. The caller resolves entry year from that validated
profile and supplies `cycle`. Grade 12 in 2026–27 corresponds to 2027 entry,
grade 11 to 2028 and grade 9 to 2030, with an explicit entry year taking precedence.
Use each returned definition's exact scope fields during instantiation; the
Campus France round changes with the procedure year.

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
in preservedCardIds. `addedCards` in review contains each missing task's complete
template card fields plus `destinationColumnId` (nullable if no column exists).
The service chooses the matching template column name, then the current column
at the template's ordinal, then the first current column. This preserves renamed
or reordered board columns and gives the preview a concrete destination.

Supply reviewed `addedCardKeys` explicitly to append selected missing tasks,
including their dates, checklists and references, without recreating the board.
The optional field defaults to no additions and supports at most 200 unique
template keys. The board lock and expected revision protect both date updates
and additions in one tenant transaction; the 500 active-card limit applies before
any changes. All added tasks receive ordinary card IDs, stable `templateCardKey`,
revision 1 and `deadlineEdited: false`. They append after current destination
cards. Invalid keys, missing columns or stale revisions do not partially change
the board.

The apply response's `cards` includes changed existing cards and new cards;
`addedCards` contains only the new cards. A retry with the old revision returns
409. After refreshing, selecting a key that is already present safely skips it
and lists it in `alreadyPresentCardKeys`, preventing duplicate tasks. Missing
tasks can also be selected later at the board's current template version.
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

The Common App release includes an ED/EA **November 1** and RD **January 1**
typical target, essay/recommendation milestones, separate financial aid preparation
and SAT preparation, registration, testing and score-reporting reminders. Typical
dates require confirmation for each chosen institution; aid priority dates are
separate and may differ. CSS Profile, institution aid forms and FAFSA eligibility
must be checked for the individual applicant. The [Common App application
guide](https://www.commonapp.org/apply/first-year-students/) and [College Board CSS
Profile](https://cssprofile.collegeboard.org/) are reference sources, not universal
aid deadline sources.

For 2027 entry, [College Board's calendar](https://satsuite.collegeboard.org/sat/dates-deadlines)
confirms the October 3, 2026 and December 5, 2026 SAT dates. Their regular
registration deadlines are September 18 and November 20 at 23:59 ET, respectively,
and those exact registration cutoffs are verified official cards.
[Score release dates](https://satsuite.collegeboard.org/scores/score-release-dates)
are October 16 and December 18. Testing cards are personal calendar reminders;
the admission ticket controls arrival time. October is the last scheduled SAT
before the typical November 1 target, and is already past at this review. A
December attempt can precede January targets only when the chosen college's
accepted-test and score receipt rules allow it. No institution's acceptance of a
specific test is inferred. Future testing reminders are planning windows requiring
the official test, registration and score-release calendar to be confirmed.

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

`pnpm --filter @palladium/planning typecheck` passed. Nine focused tests passed:

```sh
TSX_TSCONFIG_PATH=services/planning/tsconfig.json node --import tsx --test services/planning/test/*.test.ts
```

They cover dated releases, future provenance, preserved old versions/card keys,
batch tenant seeding, explicit review/additions, preservation of edited dates,
destination columns, addition retry deduplication, capacity and stale revision
and scope/actor rejection. Service tests use a transaction fixture; they do not
replace database RLS integration checks. No migrations were needed or applied,
and no provider actions were performed. Root owns dependency installation, service
registry, queue wiring and deployment. Multiple boards, card/column changes and
source-backed dates are implemented independently of provider credentials.
Arbitrary link previews, external document creation, provider deadline monitoring
and automatic homework completion are not advertised capabilities.
