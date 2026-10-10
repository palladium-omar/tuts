# Student workspace UI

## Entry points

- Tutor workspace `/`: the **Student tracker** opens groups and student cards. Student details link to a student-filtered Learning workspace and the student's Planning workspace.
- Student or guardian workspace `/portal`: sign in or register with the invited email, then select an authorized learning space and student. Business and student query parameters select context only; access still comes from server-verified grants.
- Invitation acceptance `/portal/invite`: Platform issues the invitation. The fragment token is used by the invitation route; the learning workspace does not store it.

## Tutor student tracker and CRM

The tracker has group folders, all students, an unassigned view, search, sorting, custom-field filters and paginated lists. The student picker retains selections across pages and limits each membership operation to 500 students. Group creation, rename, deletion and membership operations use Clients APIs.

Photos accept inline PNG, JPEG or WebP images up to 256 KiB. Student details reuse the CRM contact editor: named contacts, relationship, multiple labeled email addresses and phone numbers, and primary choices. Detaching a contact keeps the underlying contact. Editing a shared contact refreshes the legacy student record before further editing.

Duplicate review displays reasons and supports keeping records separate or choosing a survivor. A merge requires a current preview, explicit conflict choices and confirmation. Issued invoice snapshots and portal access warnings remain visible. CSV/XLSX import preview requires explicit decisions for candidate matches; unresolved review rows cannot be committed. Name-only students can be created; shared household addresses do not establish student identity.

Adding students offers an invitation preview only for newly changed memberships. Invitations require selected actual student/guardian email addresses and staff confirmation; membership itself does not send an invitation. Sender status, queued delivery, failed delivery, provider acceptance, accepted access and revoked access are distinct states. Fresh manual links exist only in component memory when returned by creation or resend. Existing invitation listings never recover their tokens. Sponsor/other contacts are excluded from student/guardian invitation grants.

## Student and guardian portal

Tabs appear only with the corresponding entitlement and read permission:

| Section | Source and behavior |
| --- | --- |
| Homework | Learning portal assignments, protected submission uploads and revision-aware submission. Tutor review determines completion. |
| Resources | Learning portal resources and protected downloads. Google Docs remain subject to Google's separate sharing rules. |
| Book a session | Server-approved official Cal.com URLs with authorized name/email prefill. External provider UI handles availability and changes. |
| Sessions | Scoped Scheduling session history. External bookings appear only after explicit staff association. |
| Invoices & payments | Scoped Billing issued invoices, recorded payments and all-time currency totals. Simulated payments are clearly separated. |
| Progress / Activity | Reporting month summaries and daily activity. Coverage, partial history and timestamps remain visible. |
| Planning | Independent Planning boards for the selected authorized student. |
| Contacts | Read-only safe Clients contact details. |

Student/guardian financial access uses `billing.read`; Reporting financial aggregates additionally require `reporting.financial`. Financial totals are all-time even when the month selector changes operational summaries. Missing projected counts are unavailable, rather than fabricated zeros. Observed partial counts are labeled. Staff can explicitly reconcile authorized source records.

Estimated activity recording runs only for a student role with a student relationship grant and `reporting.write`. Guardians are excluded. Recording begins after actual interaction, only while visible and recently interacted with; intervals are capped and server cursors deduplicate overlapping tabs. No keystroke content, full URLs or external-document time is captured. Network failures can undercount and are shown as unavailable recording.

## Planning boards

`StudentBoards({api,business,studentId})` is reusable in tutor and portal workspaces. It supports multiple paginated boards, creation, settings, deletion, columns, task details, checklists, links, Google document references, attached Learning resources, and optional homework references. Column selectors and up/down/left/right buttons provide keyboard movement. Task movement never completes or submits Learning homework.

Private boards are visible to their creator and authorized business administrators. Shared boards are accessible to granted students and guardians. The server's `canManageStructure` controls settings, columns and deletion; it is not inferred from a tutor label. Task edits require `planning.write`; creation additionally requires `clients.read`. Mutations carry current revisions. Conflicts are displayed and require refreshing before retrying. Destructive operations require explicit confirmation. Successful writes whose subsequent refresh fails stop further edits until the board is refreshed.

The template library reads published UCAS, Common App, Bocconi and Campus France definitions. The applicability wizard requires the template's exact entry cycle, destination, applicant category, program/procedure and round; constrained applicant countries must also be selected. It displays official sources, source review dates, deadline timezone and verification status. Unknown dates require explicit acknowledgment and remain unset. No universal college or application deadline is invented by the UI. Template instantiation uses a stable request key for retries.

Users can add personal dates or enter sourced official dates with a timezone offset. Edited official dates remain marked as requiring confirmation; the frontend cannot assert verification. Published template updates require an explicit preview and selected deadline changes. User-edited dates are preserved, and new template cards are not silently added.

## Current limits and checks

- Tracker detail Learning and session snapshots show up to 200 returned records and say so; full Learning, portal, tracker, finance, activity and board lists paginate independently.
- Booking uses provider links. The UI does not create fake availability, cancel provider sessions or infer completion from scheduled sessions.
- Google document creation through OAuth is unavailable. Staff can attach an actual shared document URL, and students can attach private submission files.
- Email sender/provider availability, protected downloads, provider delivery and live authorization require runtime validation with synthetic accounts. Static compilation does not establish external-provider readiness.
- This UI checkpoint passed `pnpm --filter @palladium/web typecheck` and a whitespace diff check. No tests, browser sessions, customer-data calls or deployments were performed by the UI agent.
