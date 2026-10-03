# External scheduling and contact connectors

This independent Nest process runs on port 4008 and owns its PostgreSQL database. Owner/admin users connect, update, sync and disconnect providers; authenticated staff may read credential-free connection metadata. Every business API requires verified membership context and the `integrations` entitlement. Data tables force tenant RLS. The service-owned discovery directory stores only business UUIDs so a worker can enter each tenant context.

## Configuration

Set `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` and `INTEGRATIONS_ENCRYPTION_KEY`. The encryption key is 32 random bytes encoded as 64 hexadecimal characters or base64. Generate it outside source control, keep it in the deployment secret store, and retain it across restarts. AES-256-GCM protects provider credentials with the business UUID as associated data. Losing/changing the key requires reconnecting affected providers. Public hook body limits are enforced by the gateway/shared bootstrap.

A real Calendly personal access token or Cal.com `cal_` API key must be supplied by the business administrator. The service verifies `/users/me` or `/v2/me` before marking the connection connected. These are token connectors; this implementation does not claim a configured OAuth application.

## Business API

All examples are request payload shapes, not saved credentials.

- `GET /v1/connections` and `GET /v1/connections/:id`: credential-free metadata, provider account, status, sync counts, last error and next due timestamp.
- `POST /v1/connections`: `{provider,displayName,credentials:{token?},config:{url?,bookingUrl?,recordsPath?,mapping?}}`.
- `PATCH /v1/connections/:id`: change displayName, credentials or the full config object. Remote validation runs again before changes persist. A disconnected record requires a new connection.
- `POST /v1/connections/:id/sync`: bounded real provider pull and durable event publication. Returns counts, timestamp and `synced`/`partial`; provider failures return 502 and persist a redacted error. A concurrent synchronization returns 409.
- `DELETE /v1/connections/:id`: revoke local credentials and form secret, stop polling, and emit a projection cleanup event. This does not cancel a remote booking or revoke the provider-issued token itself.

Providers: `calendly`, `calcom`, `json_api`, `form_webhook`. Booking URL is optional and stored for external navigation only. This service never creates, edits or cancels provider bookings.

## Contact endpoints and forms

For `json_api`, `config.url` is a reachable HTTPS JSON endpoint. An optional bearer token is encrypted. The endpoint is called and the record shape checked before connection creation. A database should expose a scoped read API returning JSON; direct arbitrary SQL/database credentials are not supported.

`recordsPath` selects a dot-separated nested array, for example `data.contacts`. If omitted the JSON response must be an array. `mapping` maps contact field names to dot-separated source paths, e.g. `{externalId:"id",firstName:"name.first",email:"contact.email"}`. Prototype paths are rejected. Records require stable `externalId` or valid email; allowed fields are externalId, firstName, lastName, displayName, email, phone, notes, status (`lead`, `active`, `inactive`) and tags. Contact IDs are at most320 characters; first/last names80, display name160 and phone3–40 characters. String and array lengths are bounded; malformed records fail the import rather than silently claim success.

For `form_webhook`, creation returns `webhookSecret` exactly once and an `item.webhookPath` shaped `/api/integrations/hooks/:businessId/:connectionId`. Store that opaque secret in the sending form service and POST `Authorization: Bearer <secret>` with one JSON contact object, an array, `{contacts:[...]}`, or a payload selected by recordsPath. Only its SHA-256 hash is stored. The public route validates the secret, provider and active connection within tenant RLS before publishing contacts. Disconnect immediately invalidates it; create another connection to rotate. Repeated records are source-upserted by CRM.

Outbound requests require HTTPS port443, reject embedded credentials and redirects, resolve all DNS addresses, reject private/special IPs, and pin a validated address in the TLS request lookup. This prevents DNS rebinding to an internal endpoint. Requests have a 15-second deadline and a 2MB response ceiling. Provider response bodies, bearer tokens and raw network errors are never reported.

## Durable synchronization

A 30-second worker scan discovers due tenant rows. Successful and failed pulls schedule the next attempt five minutes later. Due state persists in PostgreSQL across process restarts. Contact dispatch requires the clients entitlement and session dispatch requires scheduling; manual connect/update/sync routes derive this from the verified signed context. The per-connection dispatch entitlement snapshot also gates background and webhook work. This snapshot is refreshed on authorized manual mutations, not through a live platform entitlement query; if entitlements are changed administratively outside current platform APIs, disconnect/reconfigure the affected connection. The current platform has no feature-change event or service entitlement lookup, so unattended freshness needs a future projection contract. Process nonoverlap and per-connection PostgreSQL advisory locks prevent duplicate replica work. Polling processes at most25 businesses per scan in rotating UUID order; large installations can therefore have a longer delay than five minutes.

Calendly reads scheduled events starting90days ago, including cancellations, and their invitees. Cal.com reads upcoming, recurring, past, cancelled and unconfirmed bookings with the same90day lower bound. Each list has at most10 pages, each page100 records; Calendly invitees also have at most10 pages per event. Entire pulls have a100request/120second start budget, contact and Cal session projections cap at2000 records. A15second in-flight request may finish after the start budget. Truncation is returned explicitly in `syncCounts.truncated`; limits define a bounded recent import, not a promise of complete historical backfill. For oversized Calendly accounts, the90request stop marks partial progress. Pagination cursors are not retained between runs, so oversized accounts need a separate future backfill feature.

State changes and emitted events commit together through the service outbox. `integrations.contacts-received.v1` carries `{connectionId,source,contacts}`; `integrations.sessions-synced.v1` carries `{connectionId,provider,ownerUserId,sessions}`. Batches contain at most200 entries. Scheduling stores a separate read-only projection. Received contact counts mean accepted for delivery, not that CRM already created records. CRM emits `clients.source-synced.v1`; `lastImportResult` holds its latest batch result (`created`, `updated`, `skipped`, `errors`, `issues`, `receivedAt`). Multiple batches report independently. Disconnect emits `integrations.connection-disconnected.v1` and scheduling suppresses later delayed batches from that connection.

Build: `pnpm --filter @palladium/integrations build`. No tests were added or run under the current task instruction. Live user-token synchronization remains dependent on real credentials being supplied.

## Primary provider documentation

- [Calendly current user](https://developer.calendly.com/api-docs/calendly-api/users/get-current-user)
- [Calendly scheduled events and pagination](https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-scheduled-events)
- [Calendly scheduled event read scopes including invitees](https://developer.calendly.com/docs/authentication/scopes)
- [Calendly importing events and invitees](https://developer.calendly.com/update-your-system-with-data-from-scheduled-events-admins-only)
- [Cal.com current account](https://cal.com/docs/api-reference/v2/me/get-my-profile)
- [Cal.com bookings](https://cal.com/docs/api-reference/v2/bookings/get-all-bookings): current documentation requires `cal-api-version: 2026-05-01`, `cursor`, `limit` and singular status filters. `/v2/me` requires bearer authentication without a mandatory version header.
