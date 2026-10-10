# Tutor CRM and tracker composition

The CRM owns record editing. The tracker owns groups, student navigation and
the tutor's student overview. Neither duplicates another service's storage or
changes who can access billing. Feature and permission checks stay dynamic.

| UI action | Owner and communication |
| --- | --- |
| Correct a student's name | CRM derives the display name when it previously followed first/last name; explicit nicknames are preserved. Existing Clients PATCH persists it. |
| Open a CRM student's tracker | The shell navigates with the student's ID; Tracker fetches Clients GET under the current business. |
| Edit a student from the tracker | The shell navigates to the same CRM editor using Clients GET. No second editor or copied state. |
| Restore a group or student after refresh/Back | Validated URL IDs identify the requested location. Existing Clients GET endpoints enforce membership and student scope; URL parameters never grant access. |
| Select students using several searches | Student Picker keeps an explicit, removable selection of at most 500 IDs. Existing group-members POST is authoritative and still deduplicates existing memberships. Invitation review remains a separate explicit step. |
| Scan student cards | Reporting's existing summary contract provides a few useful metrics. Unknown/partial history remains visible; full metrics remain in the detail view. |
| Open homework | Learning owns assignment lifecycle and file storage. Tracker orders the returned list for tutor attention and routes to Learning for assignment/review. |
| Review a specific submission | Tracker passes student and assignment IDs to Learning. Learning fetches the assignment again and checks the requested student before opening it. The shared submission component displays text, safe HTTPS links and stored files; downloads use Learning's existing authenticated endpoint. |

Tutor-only navigation uses `contact`, `group`, `student`, `trackerView` and
`trackerTab`. The main shell removes stale child locations when switching
businesses or sections. Restoring a location re-fetches the record, handles
denied/deleted IDs and never reconstructs permissions from browser state.
No database migration, new provider, service binding or paid resource is needed.

See [the student workspace architecture](student-workspace.md) for service
ownership, and [the student portal UX contract](learner-planning-ux.md) for the
separate student-facing workflows.
