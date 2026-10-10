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

Financial data is never loaded as part of this planning flow. All requests use
the existing gateway, signed tenant/student scope and independent domain service.
