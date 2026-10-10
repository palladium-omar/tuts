# Kanban interaction and planning review — 2026-10-10

## Changes
- Board-local optimistic move queue, serial HTTP writes with acknowledged revisions; later moves remain visible.
- Whole-card mouse/touch dragging; click, menu and keyboard behavior retained.
- Clients-owned validated education profile, safe student projection and tutor editor. Grade plus recorded academic year selects entry. Missing facts use a guided prompt.
- Immutable dated template versions; official verified dates separate from suggested institution-dependent targets. ED/EA, RD, financial aid and SAT tasks are included.
- Reviewed existing-board upgrades append selected missing tasks without replacing manual tasks or edited deadlines.

## Evidence
- 39 web tests passed (including rapid move, same-card reorder, navigation, conflicts, recovery and grade resolution).
- 28 Clients tests passed with real PostgreSQL RLS test, no skipped tests.
- 9 Planning tests passed, including immutable seed batching, scoped revisions, selected additions and retry deduplication.
- Clients, Planning and web typechecks; backend builds and service boundary check passed.
- Actual local browser: grade 11 in 2026–27 selected 2028 automatically; created 18 dated tasks through the real API.
- Whole-card consecutive drags while responses deliberately delayed 15 seconds: cards remained enabled; leave/reopen retained queued intent; subsequent fresh API reads confirmed positions.
- Existing four-task v1 board upgraded via browser to 18 dated cards at v2 with unique template keys.
- Tutor education editor changed grade 11 to 12 and the next guide selected 2027.

## Deployment and limits
Clients migration 007 is nullable/additive and preserves existing records and forced RLS. Deploy Clients and Planning before gateway assets, retaining variables/secrets. Private release receipts are kept under .local/planning-ux. Synthetic test routes were removed before commit/export.
Pending intent is held in browser memory; full-page reload is not an offline persistence mechanism. Future official calendars are not fabricated: preparation targets are labelled for confirmation. Existing boards require the reviewed update action.
