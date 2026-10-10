# Student portal walkthrough — 10 October 2026

## Method

Used the actual portal in an isolated browser at desktop and 390 × 844 mobile
sizes, backed by the running local gateway and independent service databases.
Created a synthetic business, tutor, student, accepted invitation, assignments,
private files, an essay reference, a session and planning boards. Outbound email
was disabled. Existing production student records were not edited.

## Findings and changes

| Observed friction | Change |
| --- | --- |
| Completed homework was the first card, ahead of work needing attention. | Default to “To work on”; filter submitted/completed work separately; prioritize due dates in the Learning portal query. |
| Resources gave every external URL the same document label. | Separate essay documents, web links and files; add existing resource-type filters and file metadata. |
| Closing a homework dialog discarded typed answers. | Save scoped text/link drafts in this tab, recover on reopening, clear after submission/sign-out, explain that selected files must be reattached. |
| Opening a task displayed a long metadata form before usable essay links. | Add a readable task view, direct document links and revision-checked checklist saves. Keep editing a separate action. |
| Milestone dates required entering raw timestamps with offsets. | Use the calendar picker and explicit IANA timezone conversion; keep official source details available. |
| Refresh returned to Homework; the selected board was lost. | Persist section/board in the URL; support Back/Forward and accessible section keyboard navigation. |
| Empty/single-page lists displayed inactive pagination buttons. | Show pagination only when another page exists. |
| A mobile keyboard drag could announce a drop without saving a move. | Keep a logical keyboard target independent of scroll geometry; preview and persist the same destination. |
| Global label styling stacked checklist text underneath its checkbox. | Give task checklist rows their own responsive layout. |

## Verified outcomes

- Signed in as the synthetic student through the real login form.
- Typed homework text, closed and reopened its dialog, and recovered the draft.
- Downloaded the actual attached private text file.
- Submitted text and an attached file; saw the pending review result and caught-up state.
- Ticked a planning checklist, changed a milestone with the calendar, and verified both after reload.
- Instantiated a Common App board through the guided flow and actual Planning API.
- Moved tasks into empty columns using mobile keyboard controls and desktop mouse dragging; verified saved destinations after reload.
- Simulated a simultaneous tutor edit; the stale student write was rejected and the current task restored.
- Verified student requests to tutor finance, reporting and CRM endpoints return HTTP 403.
- Checked mobile task/guide geometry: page width equalled the viewport, with no task content extending outside it.
- Passed web type checking, Learning type checking, service boundary checks, four web tests, eight Learning tests (including real PostgreSQL scope/lifecycle checks), and nineteen shared runtime tests.

No live external booking, Google document edits, email delivery or payment was
performed in this walkthrough. The synthetic essay reference verifies its place
and link in the UI, not Google sharing permissions. The changes require no new
paid service or database migration. Architecture and communication contracts are
documented in [learner-planning-ux.md](../architecture/learner-planning-ux.md).
