# Student overview and actionable planning

The student portal defaults to Overview: progress, outstanding homework, planning tasks, upcoming deadlines and sessions. Financial data remains available only in the tutor workspace.

## Domain ownership

- Learning supplies a student-scoped aggregate of assignment status and upcoming homework. Scheduling supplies completed/upcoming session counts and the next scheduled sessions. Each summary reads only its own database and enforces the existing student permissions and canonical identity checks.
- Planning supplies `GET /v1/overview?studentId=UUID`: `summary` with `total`, `pending`, `inProgress`, `completed`, `overdue`, `dueSoon`; a bounded `tasks` list with board names, column kinds and deadlines; a separate `upcomingTasks` list of up to five incomplete tasks with future deadlines ordered nearest first, and a bounded `boards` list with progress counts. `tasks` remains limited to ten priority tasks and `boards` to twenty; overdue backlogs cannot hide the independent upcoming list. Private tutor boards and archived records are excluded for student contexts. The route requires `planning.read`, opts into student scope and validates the requested/canonical student before querying.
- The portal composes permitted summaries concurrently. Each section can fail independently, includes a retry, and distinguishes unavailable data from a genuine zero. It never requests every board detail or every assignment to calculate totals. Results use the existing authenticated API cache and clear on student/account/workspace change.
- Overview requests fresh summaries on mount and observes workspace API invalidations while mounted. A background mutation refreshes only affected permitted summaries. Per-domain request generations reject older responses; unmount detaches the observer. Existing values stay visible while refreshing, with a freshness notice/retry if a refresh fails. Access revocation clears values and stops further reads. There is no polling.
- Navigation from Overview preserves student, section and board identity. Existing deep links remain supported; existing workspace capabilities decide which sections appear.

## Boards and sources

Whole-card pointer dragging stays optimistic with background persistence and revision conflict handling. Move controls leave the normal card layout; keyboard and touch users retain accessible alternatives in the card menu. Buttons, links and editable controls do not accidentally activate a drag.

Built-in templates publish new immutable versions containing task-specific HTTPS references and short checklists. Existing boards remain unchanged until their owner explicitly applies a reviewed template update. Applying references/checklists must preserve manual edits and dates, and must be permission-checked. Official provider guidance is linked from the task where the action occurs. Suggested planning targets remain distinct from official deadlines; accommodations and financial-aid eligibility are never inferred from names, nationality or health information.

## Brand assets

Provider logos are local static assets mapped by stable provider/template identifiers. They communicate integration or application destination; they never imply affiliation or permission to access a provider. Source attribution and asset provenance are recorded beside the assets. No external tracking image requests are needed.

## Verification

Use synthetic local accounts and data to exercise the actual student portal: overview links, template creation, task resources/checklists, editing, dragging, reload persistence, keyboard movement, empty/error states and responsive layout. Never change a real student's tasks or submit external applications. Run affected frontend, domain permission/isolation and template-version tests before publishing. Keep this document and the UX review current with verified results.

Planning computes its aggregate and bounded lists in one SQL statement. Learning and Scheduling currently read their counts and bounded lists with separate statements in the same tenant transaction; concurrent external writes may briefly make a count differ from its list. This is a display consistency limit, not an authorization bypass.
