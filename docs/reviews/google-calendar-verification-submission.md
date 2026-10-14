# Google Calendar verification submission record

Prepared October 12, 2026 from the current implementation, public product/privacy
page source, release evidence and official Google documentation. This document
records the completed submission, reviewer evidence and current implementation.
The coordinating operator confirmed the live console readbacks below. Google
has received the sensitive-scope review request; approval has not been granted.

Product homepage: https://tuts.palladiumscholars.com/about

Privacy notice: https://tuts.palladiumscholars.com/privacy

OAuth callback: https://tuts.palladiumscholars.com/integrations/google-calendar/callback

Only the following two scopes are requested. No new scopes or provider code
changes are proposed.

## Actual console and evidence status — October 12, 2026

The coordinating operator reported the following live findings. Branding and
sensitive-scope verification are separate processes; none of these findings
establishes approval of the sensitive Calendar event scope.

| Item | Actual status |
| --- | --- |
| Existing branding | Already verified and published when the console was opened |
| Homepage correction | OAuth homepage saved from `/` to the public `/about` page |
| Corrected branding | Verified and published; actual readback: **Your branding has been verified and is being shown to users.** |
| `calendar.calendarlist.readonly` | Classified **non-sensitive** by the actual Google console; remains declared and requested for the calendar picker |
| `calendar.events.readonly` | The only requested scope requiring sensitive-scope review |
| Submission text | Saved 918-character events justification and 939-character additional information |
| Fresh reviewer walkthrough | Final video is 119 seconds with 14 frames: thirteen genuine live computer-use captures and one authentic user-provided unverified-app warning screenshot; transparently labelled as edited, not continuous |
| Captured flow | Real account chooser/public client ID, consent for both read-only permissions, dedicated synthetic calendar selection with CRM import off, a no-guest/free/no-notification event created directly in Google Calendar, its imported Sessions record, exact source-event opening and disconnect |
| YouTube | Created the business Google account's **Tuts verification** channel following user-approved Terms of Service acceptance; uploaded and verified the walkthrough as **Unlisted** at [the submitted video](https://www.youtube.com/watch?v=Pzr6d4ldi0E) |
| Scope submission | Successfully submitted after retrying one generic Google submission error; Verification Center readback: **Your app's data access is under review.** |
| Verification progress | Trust and Safety received the form; all seven displayed requirements are in progress. The console says first contact by email in three to five days and review may take four to six weeks |
| Consent screen during review | The previously approved consent screen remains in use, according to the console |
| Google sensitive-scope approval | Not granted or claimed |
| Synthetic evidence cleanup | Connection disconnected, no CRM contacts created and the synthetic test event moved to Google Calendar Trash; no secrets or test credentials supplied |

The walkthrough is an edited sequence of genuine screenshots, not a continuous
screen recording. The final uploaded version includes the authentic
user-provided warning screenshot and thirteen genuine live UI captures. Its
captured scope is listed above; earlier release evidence
separately documents additional update, cancellation and synchronization checks.
No credentials, private calendar identifiers or customer records belong in this
document or the reviewer video.

## Sensitive scope rationale

The explanation below documents the implemented scope need. The saved console
submission used the 918-character justification recorded above; this text is
not presented as an exact transcript of that field.

### `https://www.googleapis.com/auth/calendar.events.readonly`

Tuts uses this scope to read tutoring appointments from one calendar the user
explicitly selects and show them as sessions in their business workspace. It
reads event titles, times, cancellations, source links and supplied attendee
details, and uses list/get requests to keep imported sessions current. Attendee
contact import into the workspace CRM is a separate opt-in setting, off by
default. Tuts never creates, edits or deletes Google events. The existing picker
supports both owned calendars and subscribed/shared calendars the user can
read. `calendar.events.owned.readonly` excludes readable calendars owned by
someone else; public-only access excludes private appointments, and free/busy
access lacks the event details needed for these sessions. Broader write access
and `calendar.readonly` are unnecessary. Google data is used only for these
user-facing features, never advertising or generalized AI/ML training.

## Non-sensitive scope explanation (reference only)

### `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

The console classifies this scope as non-sensitive. The following explanation
supports the declared picker scope; it is not an additional sensitive-scope
review request.

Tuts uses this scope to show the Google calendars the user can read so they can
explicitly choose one to connect. The picker shows each calendar's name, primary
status, timezone and access role, including readable subscribed/shared
calendars. The backend verifies that the selected calendar came from this
readable list before saving the connection. Tuts then reads events only from
that selected calendar. This scope provides the read-only CalendarList list
method required by the picker; event-only, owned-event and free/busy scopes do
not provide that calendar list. Calendar-list write access and the broader
`calendar.readonly` scope are unnecessary. Tuts does not add, remove or modify
calendars in the user's Google account.

## API methods and actual data flow

| Purpose | Google method and request | Current application bounds |
| --- | --- | --- |
| Explicit readable-calendar picker and selection validation | `calendarList.list`: `GET /calendar/v3/users/me/calendarList` | `minAccessRole=reader`, pages of at most 250 entries, at most ten pages/2,000 entries; truncated lists are labelled |
| Appointment discovery, recurring instances and explicit cancellations | `events.list`: `GET /calendar/v3/calendars/{calendarId}/events` | Exactly the saved selected calendar; ninety days past to 180 days ahead; `singleEvents=true`, `showDeleted=true`; at most ten pages/2,000 records |
| Reconcile previously imported appointments missing from a complete discovery list | `events.get`: `GET /calendar/v3/calendars/{calendarId}/events/{eventId}` | Same selected calendar; only known private provider IDs; at most twenty reads/four concurrently, within the shared nineteen-second operation budget |

Calendar requests use the fixed `https://www.googleapis.com` origin. Token
exchange/refresh use the fixed `https://oauth2.googleapis.com/token` endpoint.
These are the only Google API operations used by the OAuth connector; there are
no Calendar write, ACL, Contacts, Gmail or Drive API calls in this connector.
The tokens are granted for the requested scope set; selecting one calendar is
an application-enforced read boundary, not a claim that Google's OAuth token
itself is limited to that calendar.

The event API may return more fields than Tuts persists. Normalized session
records contain title, start/end, provider status, supplied attendee name/email,
source link and revision timestamps. Calendar descriptions, event descriptions
and locations are not part of the stored session projection. All-day and
non-appointment event types are excluded. Timed events without invitees are
included by default and can be excluded by the tutor. Multiple invitees do not
establish one billable student; attendance and student associations remain
explicit tutor review.

OAuth applies only explicit provider cancellations. Private prior snapshots let
sparse tombstones preserve previously imported start/end dates. Missing records,
access errors and unsupported conversions preserve prior data and surface
review/repair state. Known appointments can be individually rechecked after
moving outside the discovery window; this use is disclosed in the privacy
notice. Private provider IDs and rotating repair checkpoints stay in the
Integrations snapshot store and are not published as metadata in domain events.
A provider's usable source-event link is retained for opening the event in
Google Calendar.

Access/refresh tokens are encrypted with AES-256-GCM and tenant UUID associated
data. They remain server-side and are excluded from normal API views/logs.
Requests require current verified business membership, owner/admin permissions
and Integrations access. Tenant tables force row-level security. Expiring sync
leases and revision checks reject publication after edits or disconnects.
Disconnect erases credentials and private snapshots and sends a durable cleanup
event that removes the source's Sessions projection. Already imported CRM
contacts are separate business records; administrators can delete them or ask
for deletion using the privacy notice's contact channel.

Attendee import defaults off and also requires CRM access. When enabled, it
imports attendee names/email from the selected calendar's event data into that
workspace's CRM. It uses no Google Contacts scope or Contacts API. Without this
option, attendee details supplied by Google can still appear on the related
session. Authorized workspace staff can view these records. Cloudflare and Neon
PostgreSQL process the data to operate the application, as disclosed publicly.
Google data is not sold, used for advertising or generalized AI/ML training.

## Why owned-only access does not cover the implemented feature

Google describes `calendar.events.owned.readonly` as access to events on calendars
the user owns. Tuts already lists readable calendars using `minAccessRole=reader`
and accepts `reader`, `writerWithoutPrivateAccess`, `writer` and `owner` roles.
A calendar shared/subscribed to with reader or writer access need not be owned
by that user. Reading that calendar is therefore part of the current connector,
not a proposed future capability. This least-scope assessment follows Google's
scope descriptions and CalendarList access-role definitions; it is not a claim
that a new delegated-account scenario was tested during this drafting task.

`calendar.events.public.readonly` does not cover private appointments;
`calendar.events.freebusy`/`calendar.freebusy` provide availability rather than
the appointment details; `calendar.addons.current.event.read` concerns the
currently opened event in an add-on, while Tuts is a server-side synchronization
connector. Tuts does not create calendars, so `calendar.app.created` cannot
supply the existing calendars users select. Broad `calendar.readonly` would
permit additional calendar reads unnecessary for the three methods above.

## Submitted evidence and possible reviewer follow-up

The existing [release receipt](2026-10-12-google-calendar.md) records live native
consent/token exchange, calendar listing/selection, initial and recurring imports,
manual title/duration updates, exact event-link opening, cancellation, initial
background synchronization across navigation, and disconnect cleanup in an
isolated synthetic workspace. It also records three mocked event-link/sparse-
cancellation tests and six web snapshot tests. Those checks establish the
recorded product behavior; they do not establish Google verification approval.
The fresh edited reviewer walkthrough and its upload status are recorded above.

- The configured OAuth homepage is `/about`; corrected branding is verified,
  published and shown to users. The public privacy notice is `/privacy`.
- Retain Authorized Domains and Search Console ownership evidence for any
  reviewer request. This record does not independently enumerate domain records
  or infer domain ownership from page deployment.
- The existing production web client requests the two read-only scopes above.
  Only `calendar.events.readonly` requires sensitive-scope review in the console.
  No client secret is included in this document or the submitted evidence.
- The submitted English edited walkthrough is uploaded as **Unlisted** at
  [YouTube](https://www.youtube.com/watch?v=Pzr6d4ldi0E). It captures
  account choice, the complete consent screen/app name and public OAuth client
  ID, calendar selection, resulting Sessions, exact **Open in Google Calendar**
  and disconnect, plus an authentic user-provided unverified-app warning.
  Update/cancellation evidence is in the separate release receipt, not claimed
  as part of these fourteen frames. If Google requests more evidence, provide
  an additional demonstration of the requested behavior. Do not show tokens,
  authorization-code URLs, secret settings, private iCal URLs or customer records.
- If requested, demonstrate a synthetic shared calendar readable but not owned
  by the authorizing account to substantiate the owned-only scope
  comparison. Do not imply the earlier live receipt tested that scenario.
- The walkthrough shows attendee import off. If Google requests demonstration of
  CRM import enabled, use controlled synthetic attendee data and show the
  resulting CRM record. Prior live checks kept this option off; do not label an
  enabled-import demonstration complete until it has actually been recorded.
- No test credentials were supplied. If reviewer access is requested, supply
  Tuts instructions privately through the verification process. The workspace
  needs owner/admin rights and Integrations/Scheduling
  access, plus Clients access if demonstrating the optional CRM feature. The
  reviewer should authorize their own Google account; platform-owned grants are
  not reused. Never publish reviewer passwords in this document.
- Sensitive Data Access review for `calendar.events.readonly` is submitted and
  under review. Record any Trust and Safety email, requested evidence and final
  decision when received. The console's three-to-five-day first-contact and
  four-to-six-week review estimates are estimates, not an approval deadline.

Reviewer route: open Tuts and create a free account and business workspace
through public registration; no payment is required for the connector. Sign in,
open **Connectors**,
click **Connect Google Calendar**, authorize the two read-only permissions,
choose a calendar, then open **Sessions**. For an update, change a synthetic
event in Google Calendar and use **Sync now** in Connectors. **Show cancelled**
reveals a cancelled record. Disconnect through the connector's confirmation
removes its Sessions projection. These steps do not create attendance, invoices
or payments without separate explicit staff actions.

## Official references and implementation sources

- [Google Calendar scope descriptions](https://developers.google.com/workspace/calendar/api/auth)
- [CalendarList list method and reader/writer access-role definitions](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)
- [Events list method and supported authorization scopes](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Events get method](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)
- [Sensitive-scope verification submission and demonstration requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- Provider: `services/integrations/src/google-calendar-provider.ts`
- Auth/selection/snapshot publication: `services/integrations/src/google-calendar.ts`
- Tenant-bound encryption: `services/integrations/src/security.ts`
- Source disconnect cleanup: `services/integrations/src/connections.ts`, `services/scheduling/src/external-sessions.ts`
- Public disclosures: `apps/web/app/about/page.tsx`, `apps/web/app/privacy/page.tsx`

## Privacy follow-up — October 14, 2026

Trust & Safety's follow-up and the privacy disclosure remediation, implementation references, deployment/readback receipts, and still-pending Google response are tracked in [the October 14 privacy follow-up record](2026-10-14-google-calendar-privacy.md). The stable `/privacy` URL was deployed and read back successfully; the existing verification email reply is prepared but unsent, and no Console resubmission or approval is recorded.
