# Google Calendar release

## Delivered

Google Calendar is a new provider in Connectors and Sessions, with the official
product icon. Integrations owns Google consent, encrypted tokens/private iCal
URLs, calendar selection and synchronization. Scheduling owns the external
session projection and tutor-reviewed attendance. CRM attendee import is opt-in.
The [architecture](../architecture/google-calendar.md) includes its data-flow
diagram, HTTP contract, limits, security controls and deployment requirements.

The connector supports recurring appointments, updates and cancellations within
90 days past and 180 days ahead. Unknown or unsupported calendar structures fail
with actionable errors. Multiple attendees do not arbitrarily become one
billable student. Elapsed event dates do not imply completed attendance.

Google API cancellation records can omit dates/update timestamps. Integrations
retains normalized prior snapshots and stamps serialized pull observation times.
Scheduling orders Google deliveries by observation separately from actual
provider timestamps, preserving cancellations, restorations and retry ordering.
Complete, nontruncated iCal snapshots can reconcile deleted appointments; partial
reads never infer absence. Individual feed identities are recorded before user
filters to avoid cancelling records merely because a preference excludes them.

## Review corrections

- OAuth code/state URLs get `no-referrer` and `no-store` at the gateway, with
  matching page metadata and immediate browser query cleanup.
- One-use state is bound to business/user, hashed and time-limited; PKCE uses
  S256. Completing the grant requires current authenticated business permissions.
- Expiring leases and revision checks fence provider responses after edits or
  disconnects. Provider requests occur outside database transactions.
- Extracting the connection view/type removed a runtime initialization cycle.
- Callback origins are checked against trusted deployment configuration.
- Secret iCal links never enter public connection properties or application logs.
- Known events moved outside the discovery window retain their new dates. OAuth
  repairs use bounded individual reads, private provider IDs and rotating
  checkpoints. Unresolved repairs remain visible for tutor review and never
  infer cancellation from an error or a missing record.
- Google feed group aliases cannot become a sole student attendee.

### Production build correction

Wrangler's previous bundles substituted a development `NODE_ENV` value despite
the runtime production variable. Bundle inspection confirmed that this removed
Platform's production HTTPS check, made its development entitlement migration
unconditional, enabled Stripe test operations and removed Google setup/callback
guards. The common Worker generator now defines `process.env.NODE_ENV` as
`production` while retaining the runtime production variable. This correction
requires rebuilding and redeploying the application Workers, not just changing
runtime settings. It does not undo any historical entitlement changes, and the
inspection does not establish that someone used the prior test-payment path.

## Checks and release evidence

Affected Integrations, Scheduling, gateway and web type checks passed. Service
boundaries and the generated inventory passed (209 routes across ten services).
The production dependency audit found no known vulnerabilities. The full static
build and Workers/Pages bundle checks passed, including the new callback route.
No automated tests were added or manually run for this request.

Scheduling and Integrations migrations `005_google_calendar.sql` were applied
through their ordinary PostgreSQL roles with verified TLS. New OAuth state and
Google snapshot tables enforce tenant RLS. Scheduling, Integrations, gateway and
Pages were published; no new hosting resource or paid plan was introduced.

The public app and health route returned 200. The callback returned 200 with
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Anonymous Google
status access returned 401. A short-lived, loopback-only private service probe
returned 200 for authenticated Google status and the existing connection list;
it confirmed the private-feed capability and reported OAuth setup pending after
the corrected production bundle. This probe
does not establish successful Google user consent or calendar ingestion.

The Google OAuth web client was created with explicit user approval, and its
credentials were stored only in protected deployment settings/Integrations
secrets. Google API activation, audience publishing and user consent are separate
provider steps. The Google console's API, audience and scope pages failed to
load, and renewing the existing CLI session requires a separate Google password
check. Until those provider steps are complete, production Google sign-in stays
disabled with an explicit status; the private calendar-link option remains
available. No live customer grant or calendar feed was supplied, so successful
calendar ingestion has not been verified end to end.

## Limits

Calendar access is read-only. Student booking remains with the existing booking
providers. Attendance and invoice creation stay explicit tutor actions. Changes
to import preferences affect future reads; reconnect when replacing a calendar
or removing old projections. Matching the same meeting across Google and a
booking provider is not automatic. Private feeds have a 2 MB response limit and
bounded recurrence support. Existing background entitlement snapshots retain
the previously documented Integrations dispatch limitation.
