# Student experience review — 11 October 2026

## Scope and implementation

This review covers the student portal, its overview, planning boards and official provider marks. Mutable browser verification used **Alex Example / Student UX Lab**, a synthetic account on the local ten-service deployment. No real student records, email campaigns, payment transactions or external bookings were changed. Production publication and read-only checks are recorded below after release.

The architecture was documented before implementation in [Student overview and actionable planning](../architecture/student-overview.md). Learning, Scheduling and Planning retain their own data, authorization and aggregate queries. The web portal composes three concurrent, independently recoverable summaries; it never joins service databases. Financial data is absent from the student overview. Logo assets are bundled locally, with [official provenance](../../apps/web/public/brands/README.md).

## Findings and changes

| Finding during student use | Implemented change |
| --- | --- |
| Portal opened without a useful daily summary | Overview is the default section, showing pending/completed homework, work awaiting review, planning progress, approaching dates and upcoming sessions. |
| Old unfinished tasks obscured upcoming deadlines | Independent priority and upcoming-date lists, with totals computed across all eligible tasks. |
| Planning dates displayed `Invalid Date` | The presentation reads the deadline's timestamp, distinguishes suggested targets from official deadlines and validates malformed values. |
| Header and metric layout consumed too much screen space | Compact student context, wrapped navigation and a two-column metric grid on a 390 px viewport. No page-wide horizontal overflow. |
| Overview task links required finding the same card again | Board/card deep links open the exact scoped task; closing clears the task parameter. |
| Plain-text templates offered little help completing work | Official application/test/aid links and concrete checklists on template tasks. SAT accommodation resources include College Board's ADHD documentation guidance. FAFSA remains an explicitly optional eligibility-dependent task. |
| Provider branding was unclear; the white Common App mark disappeared | Official Cal.com, Calendly, Common App, UCAS, Bocconi and Campus France assets. Common App retains its original mark on a dark backplate. |
| Visible movement controls and lengthy columns made boards cumbersome | Whole-card mouse dragging, bounded independently scrollable columns, fixed column headings, compact toolbar and a secondary accessible movement menu. |
| Moving tasks interrupted the workflow | Optimistic movement with queued background persistence and conflict handling; task cards remain interactive while moves save. |
| Template and task dialogs exposed too much metadata | Source metadata and resource details are collapsible; previews show the first five tasks with the rest available on demand. |
| Template review offered already-existing resources | Only actual additive resource/checklist changes are proposed. Every change remains opt-in, including select-all actions. Completed checklist items and manual content survive updates. |
| Campus France Morocco's closing time displayed one hour early | New immutable 2027 template version 4 encodes 15 November 23:59 local time correctly. Previous versions remain available; existing boards receive an explicit review proposal. |
| Returning to Overview showed stale homework counts | Each mount/retry requests fresh independent summaries. Submitting homework updates the overview on return without polling. |
| Navigating away before a background move finished could leave Overview stale | A mounted invalidation observer refreshes the affected summary after persistence. Older overlapping responses are ignored; existing values remain visible during refresh. |
| Live anonymous visits showed an authentication error above the login form | Expected HTTP 401 resets the portal to its clean sign-in state. Other service/network errors remain visible. |
| A long planning backlog pushed approaching deadlines below the first desktop row | Independent desktop stacks put upcoming deadlines beside homework; mobile orders homework, approaching deadlines, planning and sessions. |

## Browser walkthrough performed

- Signed in as the synthetic student through the actual login form; checked Overview, Homework, Resources, Book a session, Sessions, Planning and Contacts. No student billing section was exposed.
- Submitted a revised essay answer for tutor review; confirmed the pending count fell to zero and two assignments appeared as awaiting review.
- Filtered resources, inspected the Google Docs essay link, and downloaded the attached essay checklist.
- Rendered a synthetic Cal.com booking configuration with the student's own name/email prefilled; the configured URL and provider mark appeared correctly. No real booking was made.
- Created Common App, UCAS, Bocconi and Campus France plans through the guided flow. Inspected official task links, checklists and relevant round/date descriptions.
- Dragged tasks by their card body to In progress and Done; reloaded to confirm persistence. Completed a checklist item and edited a task without losing its references or completed state.
- Used keyboard pickup/movement/drop and Escape cancellation, and the secondary move menu. Scrolled a long column to its final task and successfully moved that task while destinations remained reachable.
- Created a blank board, added a task with details/checklist/homework reference, checked it off and moved it to Done; verified persistence after reload.
- Updated an older Common App board by selecting one resource update and one optional addition. Unselected tasks remained unchanged. Updated Campus France v3 to v4 with one selected deadline and zero redundant resource proposals.
- Checked the 390 × 844 layout. Overview uses two metric columns; the page stays 390 px wide. Planning's horizontal scrolling stays inside the board.
- Moved another task and immediately returned to Overview; its completed total changed from three to four after the background save.
- Final layout check confirmed Homework and Upcoming deadlines begin at the same desktop height (565 px); mobile section order follows urgency and the page still has no horizontal overflow.

Screenshots are local, ignored verification artifacts under `.local/student-ux-20261011/`, not student data committed to Git.

## Remaining UX opportunities and verification limits

1. **Per-institution plans:** the Common App template supplies broadly useful preparation targets and official source links. College-specific rounds, financial-aid deadlines and test policies still need the student's selected institutions and explicit confirmation; generic targets must not be presented as universal official deadlines.
2. **Homework navigation:** planning tasks can reference homework, but their detail currently directs students to the Homework section. A direct assignment link would reduce navigation further.
3. **Optional reminders:** notification preferences and deadline reminders would make impending dates useful beyond opening the portal. They are not introduced implicitly by this release.
4. **Touch and external systems:** responsive layout and mouse/keyboard interactions were exercised. Physical touch gestures, real Cal.com scheduling and Google Docs permission/sharing flows were not exercised. The local booking and essay links were synthetic.
5. **Failure recovery:** summary adapters and permission boundaries have automated coverage. An interactive simulated network-outage walkthrough remains separate from the successful browser flow above.

## Validation and publication

Validation passed:

- 65 frontend tests, 174 tests across all ten service databases using ordinary SQL roles, and 15 deployment/CSP tests; zero failures and zero skips in these runs.
- All-package typecheck, service import boundaries, generated inventory (181 routes), reviewed input-schema examples and production dependency audit. The audit reported no known vulnerabilities; this does not prove the absence of security defects.
- Production static export and CSP regeneration. The CI Node 24 runtime was also checked against the Morocco timezone conversion (Node 24.21.0, tzdb 2026c).

Published Learning, Scheduling and Planning Workers, then the gateway and Pages portal, through existing Wrangler credentials. No database migration or new infrastructure subscription was required. Domain Worker versions:

| Service | Version |
| --- | --- |
| Learning | `7e91dea5-7689-4d67-a5d7-f1a167ae72a0` |
| Scheduling | `6a42268e-f2e4-4aaa-933e-254ad6adc47b` |
| Planning | `00f0b3cc-77ad-4d29-a5e6-1ce45f405b8d` |

Read-only live verification at **2026-10-11 13:01 UTC** confirmed HTTP 200 for the homepage, student portal, gateway health and all six brand assets with appropriate content types. Live CSP exactly matched the rebuilt configuration. Requests to all three new summary routes with a synthetic business identifier and no session returned HTTP 401. Anonymous requests without a business identifier returned the expected HTTP 400 `business_required`; no student data was exposed.

The live portal completed loading to a clean sign-in form, without the false session-error banner or browser console warnings/errors. Authenticated task mutation, homework submission and template walkthrough evidence above is local synthetic verification, not a production customer-account test.
