# Tutor CRM and student tracker walkthrough

## Environment and scope

Used an isolated browser against the local application and its real local
services, with an existing synthetic owner/tutor in Student UX Lab. All names,
addresses, groups, uploaded answers and assignments were synthetic. No real
client records, provider bookings, messages or charges were changed.

## Findings and fixes

| Tutor workflow | Finding | Change and verification |
| --- | --- | --- |
| Correct a contact's surname | The generated display name retained the old surname. | Generated names now follow first/last name edits while explicit nicknames remain intact. Saved Maya Patel-Smith and read it back in CRM and tracker. |
| Move between CRM and a student's tracker | Repeated searching and lost context made navigation cumbersome. | Added direct record/tracker actions, URL-backed group/student/tab locations and browser Back support. Verified refresh, Documents tab restoration and return to the same CRM record. |
| Add several students to a group | Searching for the second student cleared the first selection. | Keep selections across searches and filters, show removable selection chips. Selected Alex and Maya through separate searches and saved both group memberships. |
| Create a group | The next action was unclear. | Creation opens the new group immediately with Add students available. Verified two persisted groups. |
| Scan students | Dense controls and repeated unavailable metrics crowded the cards. | Compact cards prioritize completed classes and homework attention, with truthful empty/partial-history copy. Progress controls and source coverage are collapsible. Inactive pagination is hidden. |
| Review homework | Tracker could not open the selected assignment directly. File-only submissions were invisible to tutors. | Direct assignment review, submitted work first, and a shared text/link/file presentation. Opened the intended assignment, displayed its uploaded answer, verified the authenticated download response matched the original file, saved feedback and needs-revision status. |
| Use a narrow screen or keyboard | Labels and selection controls could stack awkwardly. | Corrected layout wrapping and checkbox rows; student detail tabs support arrow keys, Home and End. At 390px the CRM, tracker and student dialog fit without horizontal overflow. |

## Additional exercised workflows

- Added a student, edited their properties and saved an Application track choice.
- Added a custom table column and filtered to UCAS, yielding the expected student.
- Imported a two-contact CSV through the actual file picker, mapping and preview;
  both contacts appeared with their expected stages and tags.
- Confirmed imported students appeared under Unassigned students and grouped
  students did not.
- Download control was exercised; file contents were verified through the private
  service response. A saved operating-system download was not confirmed.

## Automated and release checks

Ten web tests cover names, scoped locations, navigation cleanup, homework order,
submission rendering, safe links and tutor financial capabilities. Nineteen
runtime tests cover existing authorization guards. Web typechecking and import
boundaries passed across ten independent packages.

An attempt to provision an extra restricted tutor membership was rejected by
automatic approval review and was not retried. Restricted tutor financial
visibility was checked with the existing capability tests; the browser walkthrough
used the existing synthetic owner/tutor. XLSX and real provider integrations were
not exercised in this pass.

The release changes the web presentation only. It adds no migrations, backend
services, bindings or paid resources. The frontend is built from the committed
Git archive so unrelated working-tree changes are excluded. Production receipt
is retained locally with the commit, deployed gateway version and asset hashes.

Architecture: [Tutor workspace composition](../architecture/tutor-workspace-ux.md).
