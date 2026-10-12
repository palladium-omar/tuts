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
- Google event source links include Google's exact `www.google.com/calendar/event`
  path and Calendar-hosted paths, with HTTPS origin/credential/port checks.
- Calendar selection is saved before its independent first sync. Per-connector
  progress and retry state keep the connection usable while the pull finishes;
  response scope and load-generation guards suppress stale local updates.

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
Three focused mocked-provider regression tests passed in
`services/integrations/test/google-calendar-links.test.ts`. They preserve Google's
actual `https://www.google.com/calendar/event` format and legitimate
`calendar.google.com` source links; reject lookalike origins, embedded
credentials, non-443 ports, HTTP and unrelated `www.google.com` redirect paths;
and check that sparse cancellation tombstones keep the prior event dates and
source link without fabricating a Google update timestamp. Repeated source-link
cases are covered in the same run. All provider fetches were mocked; these tests
made no network or database calls.

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
the initial probe confirmed private-feed availability and reported OAuth setup
pending after the corrected production bundle. Configuration probes alone do
not establish consent or ingestion; the subsequent live native checks below
provide that evidence.

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

### Live native OAuth and manual synchronization

On October 12, user-approved Google OAuth completed through the production Tuts
interface, including account selection, consent, callback/token exchange,
calendar listing and explicit calendar selection. Initial appointments appeared
in Sessions. These checks used an isolated synthetic Tuts business/account and a
synthetic Google event. CRM attendee import stayed disabled; no attendance,
invoices or payments were created.

Changing the same Google event's title and duration to ninety minutes, then
requesting a manual sync, updated its existing Tuts session. **Open in Google
Calendar** opened that exact event. The provider's actual link uses
`https://www.google.com/calendar/event`, which the original allowlist omitted;
the corrected allowlist accepts that exact Google path and retains the existing
Calendar-hosted links.

Deleting the synthetic event with Google's ordinary Trash action, then manually
syncing, changed the same Tuts session to cancelled. **Show cancelled** displayed
that record with its previously imported ninety-minute start/end dates. This
live cancellation check complements the sparse-tombstone regression test.
Readback APIs all returned HTTP 200: Scheduling contained one cancelled external
session, Clients contained zero contacts, Billing contained zero invoices, and
Payments contained zero checkouts.

The per-card initial background-sync lifecycle was deployed in `9445a77`:
selection persists independently, the first pull starts in the background, and
sync progress or retry errors belong to the affected connector. `4008cb4` added
an in-app disconnect confirmation and restored progress for retained syncs after
API-context changes.

The first rapid-navigation check exposed a stale Sessions view: the initial
read could complete before Scheduling consumed the event, and Sessions did not
subscribe to API invalidations. `0acfd55` adds that subscription and a bounded
thirty-second projection refresh window. Running reads coalesce; existing rows
remain visible. Six focused web API snapshot tests passed, including completion
markers, retained navigation signals, business isolation, expiration and
access/disposal fencing. The static export and both GitHub builds passed.

The final native reconnection check completed at 19:09 UTC, between the
fifteen-minute scheduled ticks. Calendar-list refresh preserved the selected
test calendar. After selecting it, the card showed **Importing your calendar
events…** while other navigation remained available. Navigating immediately to
Sessions produced the recurring appointments automatically, without **Sync now**
or a manual page refresh. The connection readback reported fourteen dispatched
events, zero contacts, no truncation and no error; thirteen appointments belonged
to the synthetic weekly series, with three visible in October. The fourteenth
record was the earlier cancelled event.

Trashing the synthetic recurring series and syncing changed all fourteen
projected records to cancelled. The final disconnect check cleared the view and
removed its Scheduling projection. A tenant-scoped read through the normal
Integrations role with verified TLS confirmed all three test connections were
disconnected, with zero retained credentials and zero private snapshots. The
synthetic account remains separate from customer workspaces; its empty Google
test calendar is retained, while test events remain recoverable in Google Trash.

One direct Scheduling read returned a transient HTTP 500 during the earlier
walkthrough. Subsequent range and full-list reads returned 200; a short follow-up
Worker tail showed two successful requests without logged exceptions. Its cause
was not established, so these results do not claim an error-free deployment.

Unattended scheduled synchronization was not separately observed. No live
private iCal feed was tested. These checks do not establish every customer's
Workspace access policy or Google's verification approval.

The public `/about` product page and `/privacy` notice are deployed. Google's
branding configuration still uses the older `/` homepage and needs updating to
`/about`; brand and sensitive-scope verification approval remain pending.

### Final deployment receipt

- Integrations Worker: `148b5775-af02-4f3f-927f-24640502f36b`, including the
  Google event-link correction committed in `9445a77`.
- Pages: `aab56e9d-75c6-4b3c-9033-7e2597267fa5`, production branch `main`,
  source `0acfd55`. Both builds for that commit succeeded. Native browser checks
  exercised this version's automatic import and Sessions refresh behavior.
- Public `/about`, `/privacy` and callback routes returned 200. The callback
  retained `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Final authenticated readbacks returned 200: zero active test connections,
  zero external sessions, zero CRM contacts, zero invoices and zero payment
  checkouts. Private token/snapshot cleanup was checked separately as above.
- No new Cloudflare resource, paid plan, Google write scope, student invitation
  or customer financial operation was introduced by this verification work.

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
