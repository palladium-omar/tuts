# External scheduling and contact connectors

> Current cross-service context: [system](../../docs/architecture/system.md), [API/schema inventory](../../docs/service-inventory.md), [security/performance audit](../../docs/reviews/2026-10-10-platform-audit.md). Service descriptions below define APIs and local behavior; provider/configuration readiness is separate.

This independent Nest process runs on port 4008 and owns its PostgreSQL database. Owner/admin users connect, update, sync and disconnect providers; authenticated staff may read credential-free connection metadata. Every business API requires verified membership context and the `integrations` entitlement. Data tables force tenant RLS. The service-owned discovery directory stores only business UUIDs so a worker can enter each tenant context.

## Configuration

Set `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` and `INTEGRATIONS_ENCRYPTION_KEY`. The encryption key is 32 random bytes encoded as 64 hexadecimal characters or base64. Generate it outside source control, keep it in the deployment secret store, and retain it across restarts. AES-256-GCM protects provider credentials with the business UUID as associated data. Losing/changing the key requires reconnecting affected providers. Public hook body limits are enforced by the gateway/shared bootstrap.

A real Calendly personal access token or Cal.com `cal_` API key must be supplied by the business administrator. The service verifies `/users/me` or `/v2/me` before marking the connection connected. Calendly and Cal.com use token connectors. Google Calendar OAuth and its private feed fallback are described below.

## Business API

All examples are request payload shapes, not saved credentials.

- `GET /v1/connections` and `GET /v1/connections/:id`: credential-free metadata, provider account, status, sync counts, last error and next due timestamp.
- `POST /v1/connections`: `{provider,displayName,credentials:{token?},config:{url?,bookingUrl?,recordsPath?,mapping?}}`.
- `PATCH /v1/connections/:id`: change displayName, credentials or the full config object. Remote validation runs again before changes persist. A disconnected record requires a new connection.
- `POST /v1/connections/:id/sync`: bounded real provider pull and durable event publication. Returns counts, timestamp and `synced`/`partial`; provider failures return 502 and persist a redacted error. A concurrent synchronization returns 409.
- `DELETE /v1/connections/:id`: revoke local credentials and form secret, stop polling, and emit a projection cleanup event. This does not cancel a remote booking or revoke the provider-issued token itself.

Providers: `calendly`, `calcom`, `json_api`, `form_webhook`, `google_calendar`. Booking URL is optional and stored for external navigation only. This service never creates, edits or cancels provider bookings.

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


## Cloudflare runtime

`src/worker.ts` exports this domain as an independent Worker through the shared Nest runtime; `src/main.ts` remains the Node entrypoint. The service retains its own PostgreSQL database, signed caller context, tenant RLS and event contracts. Migrations are applied during deployment, outside requests. Worker secrets and bindings are supplied by the deployment configuration.
The private runtime tick calls `ConnectionsService.poll()` on the central 15-minute cron; event subscriptions register without Node intervals or an initial poll. Cal.com and Calendly requests use fixed HTTPS origins through fetch, reject redirects, bound bodies to 2 MiB and retain a 15-second deadline. Inbound signed form hooks remain supported. Arbitrary JSON endpoint pulls are explicitly unavailable in Workers: node DNS lookup and HTTPS lookup pinning are unsupported there. They require an egress adapter that preserves public DNS validation and IP pinning; the Node transport keeps these checks. See [Cloudflare DNS support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/) and [HTTP request differences](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/).

Worker fetch uses `redirect: "manual"` and rejects every 3xx response without following it; workerd does not support `redirect: "error"`. Transport failures distinguish timeout, connection failure and interrupted response. Structured diagnostics contain only provider, request phase, elapsed time and a static failure classification; tokens, response bodies and raw exceptions are excluded. HTTP errors retain their status even if response cleanup fails.

Authentication rejection (401), insufficient access (403) and provider rate limits (429) have explicit user-facing messages. The redirect fix follows [workerd's request parser](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B), which accepts `follow` and `manual`. A successful build or deploy does not establish that a supplied key is valid; reconnect requires provider acceptance with the current key.

## Student portal booking and Cal.com hooks

Apply `004_portal_booking.sql`. Integrations needs a private `CLIENTS` binding
(or local `CLIENTS_URL`) and `PORTAL_INTERNAL_SECRET` shared with Clients to read
an already-authorized student's contact prefill. These fields are never queried
through cross-service SQL.

- `GET /v1/portal/booking-config` returns `{item:BookingConfig|null}` for the signed-in staff account. Requires `integrations.read`; staff roles only.
- `PUT /v1/portal/booking-config` accepts `{displayName,bookingUrl,connectionId?:uuid|null,enabled:boolean}`. Requires `integrations.write`, staff role, and scope-safe account ownership. `bookingUrl` is a public `https://cal.com/...` path without query parameters/fragments/credentials. An optional connection must be an active Cal.com connection owned by this tutor. No API key is required for a public link.
- `GET /v1/portal/booking?studentId=UUID` requires the student's grant, `integrations.read`, `scheduling.read`, and Clients/Scheduling/Integrations entitlements. It returns `{items:[{id,ownerUserId,displayName,bookingUrl,connectionId,syncAvailable,webhookConfigured,associationMode:'staff_review',prefill:{name,email?}}]}`. Safe existing Cal.com connection links are used as defaults until a tutor explicitly configures or disables their link. API credentials and account email are excluded.
- `POST /v1/connections/:id/calcom-webhook` requires owner/admin and `integrations.manage`. It generates/rotates an encrypted per-connection HMAC secret and returns `{item:Connection,webhookSecret,webhookPath,registered:false,registration:'manual',triggers:string[]}`. The secret is shown once; later connection views only show `calWebhookConfigured` and `webhookPath`. Disconnect removes the encrypted secret and immediately rejects new hooks.

`BookingConfig` contains `{id,ownerUserId,displayName,bookingUrl,connectionId,
enabled,createdAt,updatedAt}`. Portal booking prefills the student's display name
and an own-contact email only when the stored addresses resolve to one distinct
email. Ambiguity omits the email. These editable URL/embed values are convenience
only and never establish a student relationship. Use the official Cal.com link or
embed; there is no locally invented availability calendar or booking create/cancel
API. Cal.com handles creation, cancellation and rescheduling in its supported UI.

To configure webhook delivery, explicitly generate the local secret, then open
Cal.com Settings > Developer > Webhooks and manually set the HTTPS gateway origin
plus the returned path as Subscriber URL. Set the returned Secret and select the
returned booking triggers. Use the default payload; custom templates are rejected
unless they preserve the documented structure. No provider webhook registration
or other provider write was performed during implementation. A configured local
secret is not evidence that the provider registered or delivered a webhook.

The existing public `/api/integrations/hooks/:businessId/:connectionId` route
accepts Cal.com's hexadecimal `x-cal-signature-256` HMAC-SHA256 over exact raw JSON
bytes. It verifies the active encrypted connection secret before applying any
state and stores a tenant-protected SHA-256 body receipt for durable replay
deduplication. Future timestamps beyond five minutes are rejected; deliveries
older than seven days are acknowledged without applying stale state. Rotating the
secret invalidates the previous signature. The Node and Worker gateways must
forward the signature and preserve raw bytes, not reserialize parsed JSON.

Supported booking hooks identify the booking UID only. The service re-fetches
canonical `GET /v2/bookings/:uid` using the saved credential and verifies that its
host belongs to the connected account. Provider `updatedAt` becomes the projection
revision watermark. Reschedules re-fetch both new and old UIDs. Missing revisions
or read failures queue the existing polling fallback instead of trusting a
possibly stale webhook snapshot. Unsupported triggers are acknowledged and
ignored; a meeting ending never establishes attendance. The API detail endpoint
uses version `2026-02-25`; the list endpoint retains `2026-05-01`.

Polling emits each provider's own update timestamp when available; otherwise it
uses the pull's start timestamp as an observation watermark. Scheduling prevents
older revisions/replays from replacing newer projection state. Public-link-only
configuration has neither API sync nor webhook delivery unless an API connection
is separately supplied. Neither attendee email nor client-supplied metadata such
as `studentId` grants portal access. Staff must explicitly review and associate an
external booking in the Scheduling class ledger. This intentionally leaves
ambiguous attendee matches in staff review.

Provider state stays scheduled until explicitly cancelled/rejected or explicitly
marked no-show by the canonical provider record. Past times no longer imply
completion. Tutor attendance overrides remain authoritative in Scheduling.

Primary documentation checked for this implementation:

- [Cal.com webhook payloads and HMAC verification](https://cal.com/docs/developing/guides/automation/webhooks)
- [Get a canonical Cal.com booking](https://cal.com/docs/api-reference/v2/bookings/get-a-booking)
- [Cal.com public booking embeds and prefill](https://cal.com/embed)

Static review: Cal no-show update hooks use `bookingUid`; ordinary booking hooks use `uid`. Both identify only the canonical provider read. Polling and individual reads require a positive connected account host ID; a malformed/missing host identity fails closed and bookings hosted only by other accounts are excluded. [Official API host response](https://cal.com/docs/api-reference/v2/bookings/get-all-bookings).

## Google Calendar

Apply `005_google_calendar.sql`. Google Calendar uses provider `google_calendar`.
Owners/admins with current `integrations.manage` and Integrations access may use:

- `GET /v1/google-calendar/status`: deployment OAuth configuration availability, a safe reason when unavailable, and `privateFeedAvailable`.
- `POST /v1/google-calendar/oauth/start` with `{displayName?}`: an authorization URL with offline event/calendar-list read scopes and PKCE.
- `POST /v1/google-calendar/oauth/complete` with `{state,code}`: a credential-free `{item}` initially `awaiting_selection`.
- `GET /v1/google-calendar/connections/:id/calendars`: bounded `{items,truncated}` readable calendars.
- `POST /v1/google-calendar/connections/:id/select` with `{calendarId,importAttendees?,includeEventsWithoutAttendees?,displayName?}`: select one calendar and schedule its pull.
- `POST /v1/google-calendar/private-feed` with `{calendarUrl,displayName?,importAttendees?,includeEventsWithoutAttendees?}`: validate and connect a Google iCalendar feed. The fixed Google HTTPS URL must be a Calendar `public/basic.ics` or `private-<hex>/basic.ics` feed, without query parameters, fragments or embedded credentials. The secret feed URL is encrypted and excluded from connection views and logs. This fallback works without a configured OAuth client. A private feed URL grants read access to everyone who holds it; use the Calendar account's reset control to revoke it remotely.

The existing connection list, manual sync and disconnect routes compose these
sources. Ordinary token creation rejects Google; ordinary patch accepts only its
display name. Use dedicated selection to update preferences. Google connection
views expose only `authMode` (`oauth` or `ical`) and safe selected-calendar metadata.
Changing a selected calendar requires a new connector. Preference changes affect
later pulls and do not remove events already projected into Scheduling.

OAuth requires deployment secrets `GOOGLE_CALENDAR_CLIENT_ID`,
`GOOGLE_CALENDAR_CLIENT_SECRET`, and trusted `GOOGLE_CALENDAR_REDIRECT_URI`.
Production also requires `GOOGLE_CALENDAR_ENABLED=true`, set only after the
Calendar API, requested scopes and intended OAuth audience are configured.
The flag defaults off; private feeds remain available independently.
Production requires the HTTPS origin from trusted `PUBLIC_APP_URL` and exactly
the `/integrations/google-calendar/callback` path. The current deployment uses
`https://tuts.palladiumscholars.com/integrations/google-calendar/callback`.
Development also accepts local HTTP on loopback hosts with that callback path.
Google Calendar API and a web OAuth client must be configured in the Cloud
project, with the exact redirect and an appropriate external customer audience.
The authenticated callback exchanges a code once and receives no tokens. State
is business/actor bound, hashed, expires after ten minutes and is consumed before
the exchange. PKCE verifiers and grants use tenant-bound AES-GCM. At most five
pending authorizations per actor, twenty per business and fifty connections are
allowed. Failed exchanges require fresh consent; authorization codes are not
replayed. Missing offline grants and revoked permissions return safe reconnect
errors.

Google refresh/list/pull operations share a nineteen-second network deadline. Network
calls run outside PostgreSQL transactions. A three-minute expiring connection
lease plus revision checks fence publication, token persistence and errors;
disconnect or configuration edits invalidate an in-flight operation. Scheduling
outbox batches and normalized cancellation snapshots commit in the same tenant
transaction. Snapshot tables force RLS and use composite tenant/connection
foreign keys. Snapshots retain a 120-day cancellation window, with at most 5,000
prior rows supplied per pull; exceeding that bound marks the result truncated.
OAuth pulls apply explicit Google cancellations only; absence from an API pull
never cancels an appointment. A fully parsed, nontruncated private feed may
cancel previously seen timed appointments missing from its complete snapshot
within the import window. Feed identities are tracked before title/attendee
filters, and unsupported identity groups protect their prior appointments.
Unknown identities mark the pull truncated. If inferred cancellations cannot
fit within the 2,000-session/cancellation bounds, no absence decisions are
published and the pull is marked truncated. Disconnect erases encrypted
credentials and local snapshots and publishes the existing durable source
tombstone.

Private snapshots also retain original OAuth event IDs and repair checkpoints.
A complete API list permits at most twenty known-event lookups per pull, with
concurrency four and the same provider deadline. This refreshes dates moved
outside the discovery window. Errors never become cancellations; unresolved or
legacy records show a repair message in Connectors for tutor review. Provider
IDs and checkpoints are never published in Scheduling events or API views.

The bounded event window is ninety days past to 180 days future. All-day and
non-appointment events are omitted. Timed events without attendees are included
by default; set `includeEventsWithoutAttendees=false` to exclude them. Importing
attendees into CRM remains opt-in through `importAttendees=true` and requires
Clients access.
Multiple attendees do not establish one billable student. Past events stay
scheduled until tutor attendance review. A private feed may contain less
attendee detail than an OAuth response; missing detail is not invented.
Calendar imports do not generate invoices, payments or student booking links.
OAuth and feed sources (or another booking provider) may overlap; staff should
review the external ledger before billing.

Manual operations use current verified gateway context. Background sync retains
the existing saved entitlement snapshot limitation described above. OAuth
configuration availability does not prove that Google consent, publication,
verification or a customer grant has succeeded. Calendar API activation and
scope setup are complete, the External audience is published **In production**,
and the deployed native OAuth capability is enabled. Each connection uses its
user's account; the platform owner's Google grant is never reused. Google
verification remains pending, with an unverified warning and 100-new-user cap
for the current personal-use rollout. No live customer grant or feed was
supplied, and no complete live connection flow has been verified. See the
[release evidence](../../docs/reviews/2026-10-12-google-calendar.md).
No tests were added or manually run.
