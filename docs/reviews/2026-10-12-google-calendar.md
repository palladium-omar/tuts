# Google Calendar release

## Delivered

Google Calendar is a new provider in Connectors and Sessions, with the official
product icon. Integrations owns Google consent, encrypted tokens/private iCal
URLs, calendar selection and synchronization. Scheduling owns the external
session projection and tutor-reviewed attendance. CRM attendee import is opt-in.
The [architecture](../architecture/google-calendar.md) includes its data-flow
diagram, HTTP contract, limits, security controls and deployment requirements.

The connector supports recurring appointments, updates and cancellations within
90 days past and 180 days ahead. Unsupported recurrence/timezone formats fail
with actionable errors. Malformed or excluded events can be skipped; unknown
feed identities make the pull partial and prevent cancellation inference.
Multiple attendees do not arbitrarily become one
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
Google snapshot tables enforce tenant RLS. All ten service Workers, gateway and
Pages were rebuilt and published, including Platform's production HTTPS check
and exclusion of the development entitlement migration, and Payments' refusal
of Stripe test operations in production. No new hosting resource or paid plan
was introduced.

The public app and health route returned 200. The callback returned 200 with
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Anonymous Google
status access returned 401. A short-lived, loopback-only private service probe
returned 200 for authenticated Google status and the existing connection list;
it confirmed the private-feed capability and reported OAuth setup pending after
the corrected production bundle. This probe
does not establish successful Google user consent or calendar ingestion.

The Google OAuth web client was created with explicit user approval, and its
credentials were stored only in protected deployment settings/Integrations
secrets. The existing Google CLI authorization was renewed and Calendar API
activation was confirmed with the supported CLI. The isolated console could not
load its project/audience settings. Native Chrome navigation to the existing
business profile resolved that setup blocker without another user login.

Both read-only scopes were declared, the application homepage and public
`/privacy` notice were saved, and the External audience was published as **In
production** on October 12, 2026. `GOOGLE_CALENDAR_ENABLED=true` was then set on
the deployed Integrations Worker and preserved in protected deployment settings.
The authenticated production status probe returned **200, available=true**;
the public privacy notice returned 200. Google sign-in explicitly asks users to
choose their own account before consent. Customers do not create Google Cloud
projects, provide a platform client secret, or share the platform owner's grant.

This is currently an unverified small personal-use rollout: Google may show an
unverified-app warning and applies its lifetime 100-new-user cap. Google's
verification approval has not been obtained. Verification is required before
expanding the integration into the broader commercial rollout; do not present
publishing status as verification. Testing-mode seven-day token expiry is no
longer the publishing-mode constraint, though Google can still expire or revoke
grants for other reasons. See [Google's personal-use exception](https://support.google.com/cloud/answer/13464323)
and [audience and publishing rules](https://support.google.com/cloud/answer/15549945).

No live customer grant or calendar feed was supplied, so successful user
consent, token exchange and calendar ingestion have not been verified end to end.
The production status probe verifies deployment configuration, not those steps.

Pages deployment metadata previously reported an older source commit even when
current assets were uploaded. The deploy script now supplies the committed Git
revision explicitly for subsequent Pages releases.

## Limits

Calendar access is read-only. Student booking remains with the existing booking
providers. Attendance and invoice creation stay explicit tutor actions. Changes
to import preferences affect future reads; reconnect when replacing a calendar
or removing old projections. Matching the same meeting across Google and a
booking provider is not automatic. Private feeds have a 2 MB response limit and
bounded recurrence support. Existing background entitlement snapshots retain
the previously documented Integrations dispatch limitation.
