# Scheduling

This service owns local session records and a separate read-only external session projection. Imported Calendly/Cal.com appointments are delivered through `integrations.sessions-synced.v1`, batch validated, tenant scoped, inbox deduplicated, and upserted by connection/external ID. Later event timestamps take precedence over older replayed updates.

`GET /v1/external-sessions` accepts optional `status`, `connectionId`, `from`, `to`, `limit`, and `offset`. Owner/admin users see the business projection; tutors see connections created under their own user ID. Items contain provider, connectionId, externalId, attendeeName, attendeeEmail, bookingUrl and `readOnly:true`. The web calendar reads this projection and uses bookingUrl for external navigation. It must not call the local edit/cancel/complete routes for these external IDs.

Supply `from` and `to` together as ISO datetimes with `Z` or an explicit UTC offset. `to` must be after `from`, and the range may span at most 93 days. The half-open interval `[from, to)` includes every overlapping appointment, using `starts_at < to AND ends_at > from`; appointments spanning a range boundary are included, while an appointment ending exactly at `from` or starting exactly at `to` is excluded. Ranged results are ordered by start time ascending, then ID. Omitting both timestamps preserves the existing start time descending, then ID order.

Responses are `{items, total, limit, offset}`. `limit` defaults to 100 and accepts 1–200; `offset` defaults to 0 and accepts 0–100,000. `total` counts all matches before pagination under the same business, status, connection, and tutor restrictions, including when the requested offset produces an empty page. Fetch additional pages for the same visible range by increasing `offset` until the accumulated item count reaches `total`.

Example: `GET /v1/external-sessions?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&limit=200&offset=0` returns external appointments overlapping October; the gateway exposes this as `/api/scheduling/v1/external-sessions`.

## Web calendar

The Sessions feature has month and week views, Today/previous/next controls, a selected-day agenda, and booking detail dialogs. Times use the viewer's browser timezone, shown above the calendar. The client converts the visible local date boundaries to UTC for the API. Weeks begin on Monday. Cross-midnight appointments appear on each overlapping day; overlapping appointments share columns in the weekly timeline. Cancelled appointments are hidden initially and can be shown with their own visual treatment.

The client reads pages of 200 for the visible range, up to 5,000 records. If more records match, it displays an explicit truncation notice and suggests switching to Week. Navigating away from a range discards late responses from that range. Calendar interactions change only the displayed view; appointment changes remain in the provider. No frontend dependency on integration-service source code is needed.

External data has no local overlap exclusion constraint: real remote appointments are retained even if they overlap. Local `/v1/sessions` remains its existing API and is not merged automatically. Disconnect events delete that source's external appointments and retain a tombstone to suppress delayed sync deliveries. Synchronization never creates, cancels or edits a provider booking.

Build: `pnpm --filter @palladium/scheduling build`. No tests were added or run under the current task instruction. Actual provider synchronization requires administrator supplied credentials.

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
`{clientId?:uuid|null,status:'completed'|'cancelled'|'scheduled'}` for staff under
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
