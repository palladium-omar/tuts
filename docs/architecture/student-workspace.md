# Student workspace architecture

Status: accepted implementation contract, 2026-10-10. Delivery evidence is tracked
in `docs/student-workspace-delivery.md`; this document is not a claim that every
capability is already deployed.

## Deployment and ownership

Preserve the existing Pages frontend, private gateway, independently deployed
Workers, service-owned Neon databases/roles, forced tenant RLS, Cloudflare Queues
and private R2 uploads. The local Node/RabbitMQ adapters retain identical domain
contracts. Add Planning (port 4009) and Reporting (4010) to the existing service
registry and deployment tooling. Do not share database tables across services.

| Owner | Authoritative records | Consumers |
| --- | --- | --- |
| Platform | Identity, memberships, capability policy, portal access grants, invitations | Gateway, UI, Notifications |
| Clients | Students, related contacts and addresses, source identity mappings, groups, merge aliases | Platform, Scheduling, Learning, Billing, Planning, Reporting |
| Scheduling | Provider booking projection and explicit attendance | Billing, Reporting |
| Learning | Assignments, submissions, resources, selected Google Docs references | Portal, Planning, Reporting |
| Billing | Rates, prior-month class billing, invoices, product/order entitlement records | Payments, Reporting |
| Payments | Provider connections, verified payment attempts and transactions | Billing, Reporting |
| Notifications | Delivery attempts and outcomes; sender adapters | Platform, staff |
| Integrations | Calendar/source adapters, synchronization, attribution destinations | Scheduling, Clients, Reporting |
| Planning | Student boards, columns, cards, templates and deadline provenance | Portal, Reporting |
| Reporting | Rebuildable summaries and first-party active-time aggregates | Tracker, business dashboard, permitted analytics exports |

Tutor and student screens compose these services through the gateway. A portal
is a presentation and authorization surface, not a second copy of the databases.

## Capability and resource scope contract

Keep `businessId` as the data isolation boundary. Separate four decisions:

1. Is the feature provisioned for this business (`entitlements`)?
2. Does the actor have the action capability (`permissions`)?
3. Is this resource inside their grant (`accessScope`, `studentIds`)?
4. Does the requested transition satisfy the domain rules?

Extend signed RequestContext with optional `permissions: string[]`,
`accessScope: 'business' | 'students'`, and `studentIds: UUID[]`. Platform computes
these from authenticated membership and access-grant records; the browser cannot
assert them. The gateway signs them and each service enforces them. Optionality
allows staged deployment; legacy signed contexts use the documented role preset.
An explicit empty permissions array denies all capabilities. No wildcard grants.

Capabilities use `<domain>.read` and `<domain>.write` plus explicit sensitive
actions: `clients.merge`, `clients.groups.manage`, `platform.invites.manage`,
`billing.manage`, `payments.manage`, `integrations.manage`,
`notifications.manage`. `reporting.financial` is required for financial summaries.
`Permissions(...)` checks the named capabilities independently of role labels;
`assertStudentAccess(context, studentId)` is mandatory for student-owned records.
Legacy staff endpoints continue requiring their role restriction in addition to
the domain permission. New student endpoints require explicit relationship scope.

Roles are default policy presets, not financial ownership. Owner/admin initially
retain their existing rights; tutor defaults preserve current product behavior.
Membership policy overrides can remove billing or grant scoped capabilities.
Financial summaries, exports and dashboard totals enforce the same checks as
invoice APIs. Hiding a navigation item is not authorization.

Future enterprise provisioning may resolve effective grants from a parent
organization, assign licenses to tutors, or place billing administration at a
different account level. It must issue an explicit grant for each business scope;
there is no implicit cross-tenant access, global role bypass or unrestricted
parent SQL query. A future billing-account identifier can be separate from the
actor and delivery business. This release does not add enterprise organizations,
license assignment, enterprise billing or a super-admin UI/API.

Feature manifests declare their entitlement, required capability, navigation,
API prefix and dependencies. Configuration and typed custom fields are data;
customer-specific forks and arbitrary executable customization are excluded.

## Phase 1: canonical students and contacts

Preserve current client UUIDs. Extend the Clients database with contact records,
multiple contact addresses and student-contact relationships. One contact may
relate to several students; email is not a unique student key. Backfill existing
email/phone without deleting originals during compatibility rollout.

Manual merge preview displays survivors, field conflicts and affected links.
Commit under the existing tenant contact lock; retain an alias/tombstone for the
old student, source links and a merge audit. Preserve issued invoice snapshots.
Emit `clients.student-merged.v1` with `{sourceId,targetId,revision}`. Consumers
repoint their own student references idempotently; they never query Clients SQL.
Access grants must not be transferred to another person as a merge side effect.
Reject merging records with portal access until grants have been reviewed/revoked.

Normalize names for candidate matching (Unicode, whitespace, case); keep original
display values. Matching names produce review candidates, not automatic merges.
Existing `(businessId, connectionId, externalId)` mappings permit automatic
updates. Shared family emails remain valid. Ambiguous imports are reviewable,
never arbitrarily matched. Remember dismissed pairs and manual decisions.

Clients owns API routes under `/v1`: `/clients/:id/contacts`, `/duplicates`,
`/merges/preview`, `/merges`, `/groups`, `/groups/:id/members`, and
`/portal/students`. Existing `/clients` remains compatible and gains `groupId`
and `unassigned` filters. Exact response contracts live in the Clients README.

## Phase 2: groups, access and invitations

Groups have many-to-many student membership. Unassigned means no active group
inside this business. Add/remove operations are idempotent; group deletion does
not delete students. Membership mutations emit `clients.group-members-added.v1`
or `clients.group-members-removed.v1`, with groupId, studentIds and revision.

After adding students, staff can enable invitation delivery to designated student
contacts. Platform validates the requested student and recipient through a signed
Clients API request. It stores a hashed expiring single-use token, recipient,
studentId, relationship and delivery state. Raw invitation tokens never enter
events, logs or public lists. Repeated group additions do not resend invitations.
Only an explicit staff invite action authorizes sending; rollout never sends to
existing contacts automatically. Group membership alone grants no portal access.

Acceptance requires a logged-in account matching the invited email; it consumes
the token atomically and creates a scoped student/guardian grant. Existing staff
membership must not be downgraded. A guardian can access explicitly linked
students. Use token URL fragments and origin checks. Revoke and resend are
audited, and failed mail stays visibly failed/pending, not sent.

Platform routes: GET/POST `/v1/portal/invitations`, POST
`/v1/portal/invitations/:id/resend`, DELETE `/v1/portal/invitations/:id`, POST
`/v1/portal/accept`, GET `/v1/portal/access`. Platform uses its existing trusted
internal Notifications channel for delivery. Configured real sender is required.

## Phase 3: portal, learning and booking

Student routes use relationship-scoped queries on every list, detail, download
and mutation. Learning remains the authority for homework status. Student
submission does not equal tutor approval. Private R2 files are served only after
authorization; never publish the bucket. Google Docs are explicitly selected
HTTPS documents, opened with Google's existing sharing controls; storing a link
does not grant Google access. OAuth document creation is a separately advertised
adapter capability, unavailable until configured.

Use the tutor's Cal.com booking URL in an official embed/link, prefilled from the
student's authorized contact. Credentials remain server-side. Signed Cal.com
webhooks update the existing provider projection and polling reconciles missed
changes. Deduplicate by connection/provider booking ID and provider revision.
Out-of-order events must not regress current state. Where a signed portal booking
intent cannot be associated through the provider, leave ambiguous attendee matches
for staff review; editable email/query parameters are not authorization.

Booking state and attendance are distinct. Add explicit no-show and attended
outcomes; past scheduled time alone does not prove attendance. Preserve tutor
overrides with provenance. Booking create/cancel/reschedule uses Cal.com's
supported UI or documented API, not a locally invented availability calendar.

## Phase 4: reporting and money

Reporting maintains tenant/student read models from versioned events. Summaries
include synchronization time and indicate missing history. Backfill through
authorized service APIs/events, not database joins. Consumers store aggregate
revision and ignore stale events. A replay updates existing projection rows.

Keep bookings, attended classes, cancellations, no-shows, homework, outstanding
invoices, confirmed collections and refunds distinct. Group cards read one
paginated summary set; detail sections read their source service when needed.
Month boundaries use the business timezone. On the first, billing targets the
previous calendar month; no-show charging is an explicit future configurable
rule, not an automatic change to the existing completed-class policy.

Active time is an estimate in Tuts: authenticated, throttled heartbeats count
recent interaction while visible, cap gaps and deduplicate overlapping tabs.
Keep daily aggregates, not keystrokes or document content. External Google Docs
time is unavailable. Activity analytics are separate from operational diagnostics.

Payment adapters retain per-business ownership and capability discovery. Real
Stripe integration must verify webhook signatures, account, currency and amount,
persist event IDs, and reconcile ordering/refunds. Checkout redirects never prove
payment. Enabling a live account or making a real charge is an explicit operator
action; deployment alone must not enable either. The local working agreement's
sandbox restriction remains until that separate action is authorized.

## Phase 5: planning, deadlines and attribution

Planning routes: `/v1/templates`, `/v1/boards`, `/v1/boards/:id`,
`/v1/boards/:id/cards` and `/v1/cards/:id`. Each board belongs to a student in a
business, with explicit sharing. Columns, checklist tasks, position and revisions
are persisted. Concurrent edits use expected revisions to prevent lost updates.
Assignment cards reference Learning IDs; moving a card never approves homework.

UCAS, Common App, Bocconi and Campus France templates are versioned records with
cycle, country/program/round applicability, official source URLs, verifiedAt,
deadline timezone and official/personal milestone type. Only verified applicable
dates are populated. Unknown dates remain visibly unverified; no fabricated
deadlines. User-edited dates are preserved when template updates are reviewed.

Capture allowed campaign/UTM attribution separately from identity. Reporting
joins verified booking/payment events to attribution by an opaque correlation
identifier. Mapping external product purchases to lesson credits requires an
explicit product/student association. Refunds and duplicate webhook deliveries
must not inflate revenue or entitlements.

Beacons creator accounts and Beacons for Brands are distinct products. Never
advertise unsupported Beacons conversion ingestion as connected. Offer tracked
links, permitted exports and explicitly supported analytics destinations; a
destination receives only the current business's selected metrics. Beacons for
Brands analytics integration is conditional on that customer's account support.

## Communication and operational contract

- Versioned `/v1` APIs, Zod validation, bounded pagination/body sizes, signed
  server context and tenant transactions for all business requests.
- Save events with state using the transactional outbox; per-consumer inbox
  deduplication handles at-least-once delivery. Add subscriptions centrally.
- Event envelopes carry event ID, business ID, version, timestamp and correlation
  ID. Mutable projections use record revision; event arrival time is not ordering.
- Use service bindings for synchronous Cloudflare calls; bound deadlines and
  explicit unavailable states prevent one broken provider blocking the app.
- Preserve redacted structured diagnostics and request references. Do not log
  emails, credentials, invitation tokens, student notes or essay content.
- Additive schema migrations, preserve existing records and grants; initialize
  new service roles/databases via existing deployment tooling. No paid hosting
  upgrade or new analytics provider is implied by this design.
- Deploy compatible consumers before activating producers/new UI. Back up before
  migrations. Code rollback does not reverse data migrations.

## Delivery sequence

1. CRM identity/contact/merge model and its UI; capability foundation.
2. Groups, portal grants, invitations and tracker shell.
3. Portal learning/resource flows and Cal.com booking/sync.
4. Attendance, Reporting, scoped financial visibility and payment adapter work.
5. Planning templates/boards and Beacons attribution interfaces.

Each phase is integrated before starting dependent phases. Parallel agents own
disjoint paths within a phase; root owns contracts, shared authorization, runtime
registration, migrations/deployment orchestration and final integration. No agent
changes production, commits, or sends external messages independently.
