# Scheduling

This service owns local session records and a separate read-only external session projection. Imported Calendly/Cal.com appointments are delivered through `integrations.sessions-synced.v1`, batch validated, tenant scoped, inbox deduplicated, and upserted by connection/external ID. Later event timestamps take precedence over older replayed updates.

`GET /v1/external-sessions` accepts optional status, connectionId and limit (1–200). Owner/admin users see the business projection; tutors see connections created under their own user ID. Items contain provider, connectionId, externalId, attendeeName, attendeeEmail, bookingUrl and `readOnly:true`. The frontend should display these beside local sessions and use bookingUrl for external navigation. It must not call the local edit/cancel/complete routes for these external IDs.

External data has no local overlap exclusion constraint: real remote appointments are retained even if they overlap. Local `/v1/sessions` remains its existing API and is not merged automatically. Disconnect events delete that source's external appointments and retain a tombstone to suppress delayed sync deliveries. Synchronization never creates, cancels or edits a provider booking.

Build: `pnpm --filter @palladium/scheduling build`. No tests were added or run under the current task instruction. Actual provider synchronization requires administrator supplied credentials.
