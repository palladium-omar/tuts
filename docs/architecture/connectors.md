# External connectors and data exchange

> **Current status:** Tuts has an integrations service with real token-based Calendly and Cal.com readers, an HTTPS JSON contact reader, and authenticated form webhooks. The code connects to these protocols, but live behavior still depends on each business entering its own credentials and has not been verified here. The connectors use user-supplied tokens, not an OAuth application. See the [integrations service README](../../services/integrations/README.md) for limits and provider documentation.

## Ownership and user flow

The integrations service runs independently on port `4008`, owns its database, encrypts credentials with `INTEGRATIONS_ENCRYPTION_KEY`, and exposes its authenticated business API at `/api/integrations/v1`. Owners and admins connect, edit, sync, and disconnect sources. Staff can inspect credential-free connection status. The service validates provider tokens before saving a connection. It never creates, changes, cancels, or reschedules a booking in an external calendar.

The staff app offers four source types:

| Source | Read direction | Authentication |
| --- | --- | --- |
| Calendly | Scheduled events, invitees, attendees, and cancellations from the recent 90-day window | Business-supplied personal access token validated against Calendly's current-user API |
| Cal.com | Upcoming, recurring, past, cancelled, and unconfirmed bookings from the recent 90-day window | Business-supplied API key validated against Cal.com's current-account API |
| Contact JSON API | Read-only HTTPS JSON response, optionally selecting a nested array | Optional business-supplied bearer token |
| Form webhook | Contact records pushed by a business's form provider or server | Per-connection bearer secret, shown once at connection creation |

These are direct token/API integrations, not OAuth. The business keeps ownership of provider authorization and can revoke it at the provider. The connector stores only encrypted credentials and sanitized account/connection metadata. A successful validation confirms the credentials against the identity endpoint; it does not certify a particular calendar's data, source field mapping, or ongoing live polling.

## Business API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/connections` | List credential-free connection state for the selected business |
| GET | `/v1/connections/:id` | Read one connection |
| POST | `/v1/connections` | Validate credentials and create a source |
| PATCH | `/v1/connections/:id` | Update its display name, credentials, or configuration; provider validation runs again |
| POST | `/v1/connections/:id/sync` | Run an immediate bounded pull and enqueue accepted records |
| DELETE | `/v1/connections/:id` | Revoke the local secret/credentials, stop future polling, and emit cleanup events |

New connections accept `{provider,displayName,credentials,config}`. Provider is `calendly`, `calcom`, `json_api`, or `form_webhook`. Calendars accept optional `config.bookingUrl`; JSON APIs accept `config.url`, optional `config.recordsPath`, optional token, and `config.mapping`. Mapping names Tuts contact properties and dot-separated JSON source paths. If `recordsPath` is omitted, the response must be an array. Requests are read-only and support at most 2,000 records per sync.

The polling worker checks due sources every 30 seconds and schedules the next attempt five minutes after a success or failure. An immediate sync is also available in the UI. Each provider pull is bounded by request count, time, pagination, and record limits; Calendly and Cal.com pulls start at 90 days ago, not full-history backfills. Truncation is reported in connection status. See the integrations README for the exact limits.

Outbound JSON requests require HTTPS on port 443, reject embedded credentials and redirects, resolve and reject private or special-use IP addresses, and pin a validated address for the TLS request. Requests time out after 15 seconds and responses are limited to 2 MB. The service reports sanitized provider errors, not raw response bodies, credentials, or network errors.

## Form webhook protocol

Creating a `form_webhook` connection returns a generated bearer secret exactly once and a path shaped like `/api/integrations/hooks/:businessId/:connectionId`. The sender posts JSON to the gateway URL formed by prefixing that path with the public gateway origin. The `Authorization` header must be `Bearer <secret>`. The gateway accepts at most 1 MB of JSON for this route, removes browser/business headers, and proxies it to the integrations service. The connector validates the secret against its hash, confirms the active connection under tenant RLS, then publishes accepted contact data. Disconnecting invalidates the secret immediately; create a new connection to rotate it.

The body may be one contact object, an array of contact objects, an object with a `contacts` array, or another object with an explicitly configured `recordsPath`. Mapping selects the source fields for `externalId`, names, email, phone, notes, status, and tags. A stable source ID or a valid email is required. Keep the secret in a form provider's server-side webhook configuration or a backend; it must not be embedded in public page code.

External form providers cannot reach a developer's `localhost` gateway. Receiving their requests requires a publicly reachable HTTPS gateway endpoint. This repository has no cloud deployment configuration; calendar and JSON API polling can still be used from the local development stack when the provider can reach the configured source URL.

## CRM import and matching

The CRM supports mapped CSV and `.xlsx` workbooks. It parses the first worksheet, displays headers for field mapping, previews create/update/skip/error outcomes, then commits only after the user confirms. Legacy `.xls` is unsupported. Use the [CRM import service README](../../services/clients/README.md#mapped-imports) for file bounds and the import API details.

Email is the import matching key. The default duplicate action is skip; update mode can replace mapped fields only when the incoming value is nonblank. Blank and unmapped values never overwrite saved properties. Ambiguous CRM email matches are errors. A source `externalId` is a stable identity per business, connection, and source; existing source links take precedence, then a single unambiguous email match can link the record. CRM sync fills empty fields only and preserves nonblank local edits, including names, email, status, and tags. Contacts without an email may be accepted from a connected source when they have a stable external ID; file import rows without email are skipped.

Disconnecting a source emits a durable tombstone event. CRM keeps the imported contacts and source links, but ignores delayed or replayed batches from that connection. Reconnecting creates a new connection ID. Source sync results are recorded by connection; counts mean accepted for delivery at the connector, with CRM changes applied asynchronously.

## Event flow

All events use the shared durable RabbitMQ exchange and transactional outbox/inbox. Connector source records travel as bounded batches of at most 200 entries.

| Event | Producer | Consumer | Purpose |
| --- | --- | --- | --- |
| `platform.business-profile-updated.v1` | platform | billing | Update the tenant-scoped seller identity projection used when issuing invoices |
| `integrations.contacts-received.v1` | integrations | clients | Upsert contacts by source identity while preserving local CRM edits |
| `integrations.sessions-synced.v1` | integrations | scheduling | Upsert the read-only external booking projection |
| `integrations.connection-disconnected.v1` | integrations | clients, scheduling | Tombstone the source, remove external session projections, and suppress delayed deliveries |
| `clients.source-synced.v1` | clients | integrations | Record the latest CRM result for a delivered contact batch |

The integrations service checks the entitlement snapshot saved when a connection was last changed before dispatching background and webhook data. Manual connector mutations use the currently verified signed request context. The platform does not yet publish entitlement changes; an administrator changing entitlements outside the current platform APIs must reconnect or update the affected source before its background dispatch snapshot changes.

## Related contracts

- [Service boundaries and feature composition](services.md)
- [HTTP authentication and public routes](http.md)
- [Event delivery and consistency](events.md)
- [Tenant isolation and permissions](tenancy.md)
- [Connector service API, detailed schemas, and provider references](../../services/integrations/README.md)
- [CRM import API and duplicate policy](../../services/clients/README.md#mapped-imports)
- [Read-only external session projection](../../services/scheduling/README.md)
