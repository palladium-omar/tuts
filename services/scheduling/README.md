# Scheduling

> Current cross-service context: [system](../../docs/architecture/system.md), [API/schema inventory](../../docs/service-inventory.md), [security/performance audit](../../docs/reviews/2026-10-10-platform-audit.md). Service descriptions below define APIs and local behavior; provider/configuration readiness is separate.

This service owns local session records and a separate read-only external session projection. Imported Calendly/Cal.com appointments are delivered through `integrations.sessions-synced.v1`, batch validated, tenant scoped, inbox deduplicated, and upserted by connection/external ID. Provider update/observation watermarks take precedence over older replayed updates; legacy deliveries cannot overwrite a modern projection.

`GET /v1/external-sessions` accepts optional `status`, `connectionId`, `from`, `to`, `limit`, and `offset`. Owner/admin users see the business projection; tutors see connections created under their own user ID. Items contain provider, connectionId, externalId, attendeeName, attendeeEmail, bookingUrl and `readOnly:true`. The web calendar reads this projection and uses bookingUrl for external navigation. It must not call the local edit/cancel/complete routes for these external IDs.

Supply `from` and `to` together as ISO datetimes with `Z` or an explicit UTC offset. `to` must be after `from`, and the range may span at most 93 days. The half-open interval `[from, to)` includes every overlapping appointment, using `starts_at < to AND ends_at > from`; appointments spanning a range boundary are included, while an appointment ending exactly at `from` or starting exactly at `to` is excluded. Ranged results are ordered by start time ascending, then ID. Omitting both timestamps preserves the existing start time descending, then ID order.

Responses are `{items, total, limit, offset}`. `limit` defaults to 100 and accepts 1–200; `offset` defaults to 0 and accepts 0–100,000. `total` counts all matches before pagination under the same business, status, connection, and tutor restrictions, including when the requested offset produces an empty page. Fetch additional pages for the same visible range by increasing `offset` until the accumulated item count reaches `total`.

Example: `GET /v1/external-sessions?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&limit=200&offset=0` returns external appointments overlapping October; the gateway exposes this as `/api/scheduling/v1/external-sessions`.

## Web calendar

The Sessions feature has month and week views, Today/previous/next controls, a selected-day agenda, and booking detail dialogs. Times use the viewer's browser timezone, shown above the calendar. The client converts the visible local date boundaries to UTC for the API. Weeks begin on Monday. Cross-midnight appointments appear on each overlapping day; overlapping appointments share columns in the weekly timeline. Cancelled appointments are hidden initially and can be shown with their own visual treatment.

The client reads pages of 200 for the visible range, up to 5,000 records. If more records match, it displays an explicit truncation notice and suggests switching to Week. Navigating away from a range discards late responses from that range. Calendar interactions change only the displayed view; appointment changes remain in the provider. No frontend dependency on integration-service source code is needed.

External data has no local overlap exclusion constraint: real remote appointments are retained even if they overlap. Local `/v1/sessions` remains its existing API and is not merged automatically. Disconnect events delete that source's external appointments and retain a tombstone to suppress delayed sync deliveries. Synchronization never creates, cancels or edits a provider booking.

Build: `pnpm --filter @palladium/scheduling build`. The 10 October audit ran all five Scheduling tests with the ordinary local database role, including its PostgreSQL isolation/ledger tests. Actual provider synchronization requires administrator supplied credentials.

## Canonical class ledger and attendance reconciliation

`GET /v1/class-ledger?month=YYYY-MM&timeZone=IANA` returns
`{items,total,truncated:false,month,timeZone}` for at most 10,000 classes, rejecting
a larger month explicitly. Items contain id/classId, source (internal/external),
title, clientId (nullable), attendeeEmail (nullable), startsAt, endsAt, status,
providerStatus (external source status), revision and updatedAt. Class start time
in the requested zone defines month membership. Internal attendance is read from
session state; external elapsed dates never imply completion. Historical source
rows are backfilled transactionally with class snapshot outbox events.

`PATCH /v1/class-ledger/:source/:id` accepts
`{clientId?:uuid|null,status:'completed'|'cancelled'|'scheduled'|'no_show'}` for staff under
the scheduling entitlement. Internal records require a student ID; switching back
to scheduled enforces the original overlap constraints and returns 409 on conflict.
External annotations persist in a separate forced-RLS table and override attendance
without rewriting the provider's status. Stable ledger history remains available
when a provider connection is disconnected, and its attendance can still be
annotated. Existing provider sessions and effective annotations are kept separate.

Ordinary session creates/edits/transitions, provider sync and ledger annotations
publish transactional `scheduling.class-updated.v1` snapshots with
`{classId,source,clientId,startsAt,endsAt,status,revision}`. Material changes increment
a per-class revision; unchanged syncs do not create new revisions. Billing consumes
these through its own projection. Internal completion via reconciliation also
preserves `scheduling.session-completed.v1`. No cross-service SQL is used.

With `SCHEDULING_TEST_DATABASE_URL`, synthetic PostgreSQL fixtures verify calendar
month/timezone boundaries, explicit attendance, provider/effective status,
revision ordering, tenant isolation, transactional backfill and overlap 409s.


## Cloudflare runtime

`src/worker.ts` exports this domain as an independent Worker through the shared Nest runtime; `src/main.ts` remains the Node entrypoint. The service retains its own PostgreSQL database, signed caller context, tenant RLS and event contracts. Migrations are applied during deployment, outside requests. Worker secrets and bindings are supplied by the deployment configuration.

## Student scope, attendance and merge aliases

Apply `004_portal_attendance.sql`. Every student/guardian read uses signed student
IDs; attendee email and editable provider metadata never establish access. Staff
routes retain their role checks and action capabilities. A tutor restricted to
student scope sees only mapped classes within those grants; unassociated external
bookings require explicit staff review before appearing in a portal.

- `GET /v1/portal/sessions` accepts optional `studentId`, paired `from`/`to` offset ISO timestamps, `limit` (1–200, default 100) and `offset` (0–100000). A supplied range must be positive and at most 93 days. Without a range it covers the previous 31 days through the next 62 days. It returns `{items,total,limit,offset,from,to}` in start-time order. Every item is read-only.
- `GET /v1/portal/classes` accepts required `studentId`, `month:YYYY-MM`, optional `timeZone` (default UTC), `limit` and `offset`; returns `{items,total,limit,offset,month,timeZone}`. Month boundaries use the requested business timezone. Current sources are reconciled transactionally before reading the ledger, including retained history after disconnect. An oversized range/month above 10000 records is rejected rather than silently claiming complete coverage.
- `POST /v1/sessions/:id/no-show` marks a scheduled local session explicitly `no_show`, idempotent for the same status. Requires staff role, `scheduling.write`, and the student's grant. Existing complete/cancel routes enforce the same scope checks.
- `PATCH /v1/class-ledger/:source/:id` now accepts `no_show` alongside completed/cancelled/scheduled. Staff association and attendance are explicit, tenant-scoped and preserved across provider sync. External attendance annotations retain `updated_by` and `updated_at` provenance.

Portal class/session items contain `{id,classId,source,title,clientId,studentId,
assignedTutorId,connectionId,startsAt,endsAt,status,providerStatus,attendanceSource,
revision,updatedAt,bookingUrl,readOnly:true}`. `clientId` and `studentId` are the
same canonical student UUID. Attendee email is excluded from portal responses.
Status is `scheduled`, `completed`, `cancelled`, or `no_show`; attendance source is
`session`, `tutor`, or `provider`. Financial consumers continue billing only
explicitly completed classes; no-show charging is not introduced here.

The revisioned `scheduling.class-updated.v1` snapshot retains all existing fields
and additionally includes `{studentId,title,assignedTutorId,connectionId,
providerStatus,attendanceSource}`. Unchanged snapshots do not increment revisions.
External projection updates use provider `updatedAt` or the observation watermark
from Integrations. Equal/older revisions do not replace current state. Explicit
class annotations remain authoritative. Legacy elapsed-time `completed` imports
are presented as scheduled unless a tutor explicitly recorded completion, and
reconciliation publishes a correcting ledger snapshot. Meeting-ended hooks and
past booking dates never imply attendance.

`clients.student-merged.v1` is consumed into a forced-RLS alias projection. Reads
and class events resolve canonical student IDs; underlying scheduled session keys
are preserved because a blind remap may violate student/tutor overlap exclusions.
New bookings and edited/reopened scheduled classes additionally check canonical
student overlap under the existing tenant scheduling lock. Merge processing
updates the ledger's association and revision atomically, without changing class
IDs or attendance and without moving a portal grant. Cyclic/stale aliases are
rejected/ignored. Clients independently forbids merging portal-protected students.

Builds/typechecks validate source compilation only. No tests, live bookings,
provider registrations or external messages were run during this implementation.

Revision precedence: an observed polling timestamp cannot replace a provider `updatedAt` revision. Provider snapshots replace observed/legacy state, then only strictly newer provider revisions apply. Scoped tutors can associate an unmatched external booking only if they own its connected account and have the target student grant; business-wide staff may perform the documented review association. Attendee email never grants student authorization.
