# Student reminders and applicant procedure review — 11 October 2026

## Scope and release state

This review records the reminder, direct-homework navigation and applicant-rule extension implemented after the [earlier student experience release](2026-10-11-student-experience.md). The architecture was written before implementation in [Student reminders and applicant rules](../architecture/student-reminders-and-applicant-rules.md). The existing ten services, their separate PostgreSQL databases and Cloudflare schedule remain the deployment model. No student billing view or new hosting subscription was added.

Application walkthroughs used synthetic local student records. Google Docs and Cal.com checks used actual external providers with test content and a synthetic booking. This is provider integration evidence for the local application; it is not evidence of authenticated customer use on the public deployment. Provider credentials, account addresses, booking identifiers and document content are excluded from this review.

**Published on 11 October 2026** at [tuts.palladiumscholars.com](https://tuts.palladiumscholars.com). All ten domain Workers, Gateway and Pages ingress were deployed. Notifications was then explicitly republished with the final database-startup timing correction. Live asset/access checks completed at **13:49:37 UTC**, and deployment receipts were read back at **13:50:34 UTC**. These checks establish the release state below, separately from the earlier student experience release.

## Implemented behavior

| Area | Result |
| --- | --- |
| Exact homework navigation | `/portal?business=<UUID>&student=<UUID>&section=homework&assignment=<UUID>` opens the authorized detail independently of list filters or pagination. Overview homework, reminder emails and planning references carry the owning business. Closing clears the assignment parameter. Back/forward restores selection, invalid identities fail closed, and stale detail requests are discarded. |
| Pending homework writes | Navigation invalidates the originating work's completion ticket. A late file upload cannot start submission or update a different assignment; a late successful submission cannot close the new assignment. A successfully submitted assignment's own draft can be cleared. |
| Reminder controls | Homework and planning task details offer a short date/time picker, tomorrow/day-before-due presets where valid, and an optional email checkbox that starts unchecked. Failure to load reminder options exposes an explicit retry and blocks saving until availability is known. |
| Reminder inbox | Overview shows due reminders and scheduled reminders in a compact inbox. Read/cancel actions, pagination, safe errors and refresh are supported. Saving or cancelling through an adjacent reminder control refreshes this student's inbox immediately without restarting the three domain summaries. |
| Reminder ownership and persistence | Notifications owns schedules, inbox state, delivery attempts and leases. Every operation checks the authenticated account, business, active student access and feature permissions. Homework/shared planning references are revalidated through their owning service. Caller-supplied recipients, messages or arbitrary outbound URLs are rejected. |
| Due state and optional email | Listing advances overdue scheduled reminders even if background email work is unavailable. The existing fifteen-minute worker handles bounded delivery work with durable leases and stable idempotency keys. Email sender acceptance is displayed separately from confirmed delivery; failures and uncertain outcomes stay visible while in-app reminders remain usable. |
| Completion and access changes | Validated homework completion, planning completion/archive/private-access events suppress reminders for the exact referenced work. Delivery rechecks current portal access. Event processing is eventual; no event grants access or retracts mail already accepted by a provider. |
| Applicant guidance | Confirmed residence, citizenship, qualification, study level and application route remain distinct facts. Missing facts prompt questions. Authorized staff may explicitly save approved facts to Clients; a board also retains its own fact/rule-version snapshot. Saved facts can be reviewed/changed and catalog failures retried. |
| Country and aid rules | Campus France is a country-aware family with scoped source records. Unresearched countries/cycles receive useful guidance and dates requiring confirmation. FAFSA covers confirmed eligible citizens and eligible noncitizens; CSS depends on participating-college requirements. Unknown eligibility stays unresolved through review tasks. SAT and accommodation choices are explicit. |
| Existing boards | New immutable versions do not rewrite existing boards. Existing opt-in template review preserves manual titles, dates, resources and completed checklist work. |
| Provider booking presentation | A Cal.com cancellation takes precedence in the student's displayed booking status while tutor attendance/billing records remain separate. Scheduling's student overview excludes provider-cancelled bookings from upcoming counts and rows. Calendar links say “Open Cal.com booking page”; changes/cancellations use provider confirmation-email management links. |

## Browser and actual provider evidence

### Homework and Google Docs

The coordinating agent exercised the actual local student portal and linked Google Docs workflow: opened the assignment/document, edited test content in Google Docs, submitted homework for tutor review and exercised the tutor review flow. This extends the prior review, which had inspected synthetic document links only.

Direct assignment links were checked alongside the homework flow. Automated checks additionally cover completed/filtered assignments, detail requests independent of list pages, invalid UUIDs, a mismatched canonical student, aborted responses and safe retry wording. Separate lifecycle checks cover navigation during pending uploads/submission.

Google controls document sharing and permissions. Access in this walkthrough was manually established; the platform does not automatically grant Google permissions or prove that another student's Google account can open the document. Homework submission and tutor review remain local service records, distinct from Google document editing.

### Reminders

The local browser walkthrough saved and cancelled reminders through the student interface and inspected their inbox state. Work-completion suppression was also verified against persisted reminder/event behavior. These checks establish in-app behavior; they do not establish receipt of a live reminder email.

The UI leaves email unchecked initially and reports sender availability from the backend. Delivery tests distinguish accepted, failed, suppressed and unknown outcomes, including duplicate schedule ticks and revoked grants. The local inbox proof is an ignored verification artifact, `.local/reminders-inbox-proof.png`.

### Country-aware Campus France plan

The final guided browser flow used **residence USA, US citizenship, Master's entry, connected Études en France and explicitly confirmed HDAP** (`campusFranceProcedure:hdap`). The student saw the course-procedure question, including architecture/art exclusions, before the deadline preview. Creating the plan persisted four personalized tasks and the scoped closing instant **15 January 2027, 18:00 in America/New_York** (`2027-01-15T23:00:00Z`). This is the researched USA later-undergraduate/Master HDAP record; it is not a universal France, first-year, nationality or future-cycle deadline.

The separately confirmed USA DAP procedure uses **15 December 2026** as a day-only source record, without inventing a cutoff time. Architecture DAP can apply at any study level. Art/other/unknown procedures receive a course-confirmation task without a verified closing instant. Missing procedure or first-year HDAP cannot instantiate; automated checks cover these branches and European eligibility.

The source register, applicability, timezone and rule version travel with the plan. Morocco's date is not reused for USA or other residences. Unknown local calendars remain marked for confirmation with official guidance links. The reviewed official source set and annual review triggers are recorded in [Annual review](../annual-review.md).

### Actual Cal.com booking and cancellation

Cal.com browser checks verified actual availability and the booking form with the synthetic student's details prefilled. **Final booking confirmation was performed through the Cal.com API**, not by completing the provider's browser confirmation step.

The provider returned success and an **accepted** synthetic booking for **12 October 2026, 17:30–17:45 UTC**. Its API subsequently returned success and **cancelled** for that booking. The local adapter/event projection associated the booking with the synthetic student and populated local scheduling records; cancellation was subsequently projected as provider cancellation.

Provider acceptance/cancellation and local projection are separate outcomes. Staff linking had recorded tutor attendance as Scheduled; that annotation does not override the student's cancelled provider booking display and does not silently change teacher attendance or billing policy. The coordinating agent then verified **Cancelled in Cal.com** in the student's Sessions view and an Overview upcoming count of **1**, excluding the cancelled test booking.

At **2026-10-11 13:35:21 UTC**, a locally generated HMAC-signed `BOOKING_CANCELLED` payload reached the **actual Integrations HTTP webhook route**. Integrations fetched the canonical booking through the real Cal.com GET API, confirmed cancellation, and applied the Scheduling cancellation projection. An exact repeat was accepted as a duplicate with **`applied:false`**; the database retained **one receipt**. The check used an ordinary database role, preserved the student link and tutor Scheduled annotation, and disabled the next polling sync so it did not account for the result. This proves signed local ingestion, canonical provider validation and deduplicated projection. It does not prove that Cal.com itself initiated the webhook or establish production push/poll timing.

The actual synthetic booking was cancelled, and the hidden test event was deleted through the Cal.com API with HTTP **200** cleanup confirmation.

Ignored local evidence files include `.local/calcom-test-booking.json`, `.local/calcom-test-cancellation.json`, `.local/calcom-linked-test.json`, `.local/calcom-projection-test.json` and `.local/calcom-cancellation-hook-proof.json`. They are not committed or reproduced here. Normal production webhook/poll timing and automatic end-to-end reconciliation latency remain unproven.

## Validation evidence

The final integration run passed **82 frontend tests and 199 service tests**, with no failures or skips. Service tests ran against ordinary PostgreSQL roles in all ten isolated databases: Platform 15, Clients 30, Scheduling 8, Learning 16, Billing 31, Payments 13, Notifications 28, Integrations 4, Planning 35 and Reporting 19. All package typechecks and the complete Cloudflare build/static portal export passed.

Automated suites cover account/tenant separation, active grants, strict input bounds, target scope, duplicate ticks, durable leases, provider acceptance uncertainty, idempotent actions, completion suppression, direct homework navigation and stale submissions. Applicant suites cover country/cycle separation, course-procedure eligibility, eligible noncitizens, institutional CSS requirements, immutable versions and server-derived instantiation.

The scheduling overview query was amended to exclude `provider_status='cancelled'` from upcoming totals and rows, independently of tutor attendance. The browser confirmed that the cancelled synthetic booking was excluded.

Post-correction checks passed **18 deployment/CSP/test-output checks**, service import boundaries across ten packages, generated inventory (**187 routes**) and the three reviewed input-schema catalog check. The production dependency audit reported **zero known vulnerabilities**; this does not establish absence of all security defects.

The Cloudflare scheduled communication/reminder callback shares a **22-second monotonic budget**, alternates priority between those queues and checks the remaining deadline before external work. Delivery reserves **18 seconds** for the bounded five-second recipient check, twelve-second mail transport and SQL margin; interactive validation retains eight seconds. An ordinary-role regression simulates two seconds of preparation and proves delivery still starts. An owned lease can be safely deferred before sending when insufficient budget remains. Busy queues can delay optional email beyond one fifteen-minute tick; in-app due state advances on listing. Multiple-business email links explicitly include the owning business.

Production migration execution reported success for **all ten services**, including Notifications migrations **003 and 004**. Successful migrations establish database schema readiness; they do not establish publication of the updated Workers or portal.

| Final integration item | Observed result |
| --- | --- |
| All-package typecheck/build and web production export | Passed all package typechecks and complete Cloudflare build, including production static portal export. |
| Full frontend and service test totals | Passed 82 frontend / 199 service tests, zero failures or skips. |
| Tenant/RLS, service boundaries, generated inventory and deployment/CSP checks | Ordinary-role service checks, ten package boundaries, 187 routes, reviewed input catalog and 18 deployment/CSP/test-output checks passed. |
| Actual signed webhook ingestion | Passed actual local HTTP route + HMAC + real canonical Cal.com GET + Scheduling projection; exact repeat deduplicated, one receipt. Production provider-initiated timing remains unproven. |
| Database migrations | Production migration execution succeeded for all ten services, including Notifications 003/004. |
| Release commit SHAs | `feda9fa` — scoped reminders, exact homework navigation and dynamic applicant procedures; `95fe5d8` — reminder delivery startup margin and regression. |
| Published Worker/Pages versions and deployment time | Current versions read back at 2026-10-11 13:50:34 UTC; see receipt table below. Each Worker version has 100% traffic. Pages production/main source is `feda9fa`. |
| Read-only production health, portal, CSP and unauthenticated authorization checks | `/health` and `/portal`: 200. Portal HTML and all ten script assets exactly match the production export. CSP exactly matches generated configuration and allows all six inline hydration scripts. Anonymous reminder, country and preview API calls: 401; private recipient/tick routes: 404. Browser portal renders sign-in with no captured console errors. |
| Authenticated production synthetic workflow | Not exercised. Authenticated synthetic workflows were local; actual provider calls were real. No test customer workspace was created on production. |

## Deployment receipts

| Service | Current version / deployment | Created UTC |
| --- | --- | --- |
| Platform | `c7c02bb7-2e36-4410-b466-9abd9ade7c2f` | 13:44:45 |
| Clients | `68db3ef2-9d0e-4b11-9faf-237b203a7b39` | 13:45:06 |
| Scheduling | `54e08f09-12ae-486d-87c4-46a0cb783036` | 13:45:32 |
| Learning | `b00bf3c6-1ab2-4d39-94d6-26ea883df074` | 13:45:57 |
| Payments | `8f2136d1-a8a5-46a7-ae27-0f6595b9bce0` | 13:46:21 |
| Integrations | `8781c949-eb8b-4c29-9dc5-b73962624e34` | 13:46:45 |
| Billing | `0529cb94-20f6-4c24-9e45-47a3a50cf2b2` | 13:47:09 |
| Planning | `f7ea9648-8a4a-49f9-993d-c329065e8163` | 13:47:33 |
| Notifications, including startup margin fix | `933386b3-aa39-4e95-8865-de1e7aafa4f9` | 13:49:12 |
| Reporting | `ca25efca-7a3c-4b13-96aa-dac3ff08793f` | 13:48:22 |
| Gateway | `4a7d147d-feea-44c4-9627-a5ed1bf21681` | 13:48:44 |
| Pages production/main | `cc42b3d1-68cd-4126-8fd4-43a0f526391b`, source `feda9fa` | Observed current at 13:50:34 |

All times above are on 2026-10-11. Read-only production evidence is held in the ignored `.local/reminder-production-proof.json` and `.local/reminder-release-receipts.json`. The portal HTML SHA-256 is `6b2b7eddaea7bd180bb3366ad0ab26d3eab6a328bf05a6873128e8d9e25b54b3`; individual script hashes were matched against the export without publishing private records.

## Remaining verification boundaries

- No live reminder email receipt or inbox delivery is established by these checks. Provider acceptance is not delivery.
- Signed local webhook ingestion and deduplication passed. Provider-initiated push/poll cadence and production reconciliation timing are not yet proven.
- Google Docs permissions remain manual provider configuration; document editing does not establish automatic sharing.
- Calendar URLs are booking pages unless separately verified as per-booking management links. No management URL is invented from a booking identifier.
- Institution-specific deadlines, federal eligibility and aid-form requirements still require explicit confirmation with the applicable institution/official guidance.
