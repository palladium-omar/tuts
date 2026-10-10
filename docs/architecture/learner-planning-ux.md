# Learner access and planning interaction

## Access boundary

The student portal contains homework, resources, booking, sessions, planning and
shared contact details. Financial history, attendance analytics, activity reports
and reconciliation are tutor workspace features. Billing and Reporting enforce
staff roles and capabilities on their read endpoints. Shared permission policy
also rejects financial and reporting reads for learner roles, even with an old
explicit capability override. Students can still submit scoped activity events;
these do not grant permission to read tutor reports.

Provisioning capabilities remain separate from resource ownership. Staff access
still requires the configured capability and business/student scope. This does
not introduce enterprise administration or move billing ownership between staff.

## Guided template creation

Planning owns boards and immutable published templates. The web client fetches
template definitions through Planning HTTP contracts. It groups procedures into
application destinations, asks a route question only when multiple routes exist,
and derives fixed applicability fields from the chosen definition. Explicitly shared student
profile information can prefill genuinely available values; missing profile information is never guessed from names or email addresses.

The final preview identifies the procedure, entry cycle, tasks, confirmed dates
and dates still requiring research. Official sources remain available in an
expandable section. Creating the board explicitly confirms that displayed scope.
Retries retain the idempotency key; changed selections get a fresh key. There are
no single-option confirmation dropdowns. Reduced motion preferences disable
transitions. No new service dependency or database migration is needed.

## Board interaction and persistence

A dedicated Kanban component handles mouse, touch and keyboard dragging, visual
drop previews and horizontal scrolling inside its own container. Board cards and
columns remain Planning resources. A drop produces the existing move request:

`POST /planning/v1/cards/:id/move`

`{expectedRevision, expectedBoardRevision, columnId, position}`

Positions are calculated between neighboring cards. The client displays the move
immediately, serializes saves, then adopts the server card and board revisions.
Failures restore the last saved view and reload current server state so concurrent
edits are not silently overwritten. Cancelling a drag does not save anything.
Column structure and task editing retain their existing authorization rules.

Keyboard arrow moves also retain a logical destination independent of the
scrolling viewport. This prevents an off-screen empty column or scroll animation
from turning a requested move into a no-op. The preview and final request use the
same logical ordering; Escape restores the saved board without writing. Mouse
and touch drops continue to use geometric collision detection.

Financial data is never loaded as part of this planning flow. All requests use
the existing gateway, signed tenant/student scope and independent domain service.

## Student task details and milestones

Opening an existing card shows its notes, deadline, actionable checklist and
document links. Editing task metadata is a separate view. A checklist change
uses `PATCH /planning/v1/cards/:id` with only
`{checklist, expectedRevision}`. The client adopts the returned revision before
another write and refreshes the board. Failed writes restore the prior checklist
and attempt to load the current server version. These are Planning writes only;
they never submit Learning homework or alter its status.

The shared calendar picker accepts human-readable wall times. A web utility
converts those times into UTC instants in the card's IANA timezone. Nonexistent
and ambiguous daylight-saving times are rejected instead of silently shifting
the deadline. Unedited official deadlines retain their existing source-review
status. Edited official dates still require source links and explicit confirmation;
personal milestones do not require the admissions metadata form.

## Homework attention and local drafts

Learning adds `status=actionable` to the portal assignment list. It means
`assigned` or `needs_revision`; the same filter is applied to both rows and total.
Portal results prioritize actionable work, then its earliest due date. Existing
staff list semantics are unchanged. Resource type filters use the existing
`kind=google_doc|file_metadata|link` contract. Both routes retain tenant policies,
canonical student resolution, bounded pagination and signed student scope.

Answers and work links can be drafted in `sessionStorage` for the current tab.
Keys include author, business, student and assignment IDs. Drafts expire after
24 hours, are accepted only for the current assignment revision, and are cleared
after successful submission or explicit sign-out. Browser storage failure is
shown honestly. Selected file bytes are not persisted, and the form explains
that they must be reattached after closing. Server submission remains the existing
revision-checked Learning request; draft saving does not submit work or send mail.

## Navigation and deployment

The portal records `section` and the selected Planning `board` in the URL.
Refresh and browser Back/Forward restore that selection. Planning requests still
validate business and student ownership on the server; URL IDs do not confer
access. Shared tutor Planning components opt into this URL behavior only when
rendered in the portal. Learning tabs support arrow keys, Home and End.

These changes use the existing Cloudflare gateway assets, Planning API and
Learning Worker. They require no new service, paid product or database migration.
