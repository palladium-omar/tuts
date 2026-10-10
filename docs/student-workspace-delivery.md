# Student workspace delivery

Architecture: [accepted implementation contract](architecture/student-workspace.md).

| Phase | Status | Evidence / limitations |
| --- | --- | --- |
| Architecture and scope | Documented | Existing Cloudflare/Neon deployment; capability-based account scope; enterprise provisioning deferred |
| 1. CRM and permission foundation | Deployed | Additive contacts/merge migration; explicit import review; scoped capability context; Clients/Platform builds, web typecheck and service import boundary check passed. End-to-end flows not exercised. |
| 2. Groups and invitations | Deployed | Scoped groups and safe student directory; invitation lifecycle and shared account form; Platform/Notifications/Clients builds pass. Sender remains unconfigured; invitation delivery failures and fresh manual links are explicit. |
| 3. Student portal and Cal.com | Deployed | Scoped homework/submissions/resources, private files, Google Docs references, Cal.com booking links and signed canonical sync; explicit attendance. |
| 4. Reporting and money | Deployed | Separate Reporting service, source reconciliation/coverage, active-time estimates, scoped financial history and real/simulated currency totals. |
| 5. Planning and attribution | Deployed | Separate Planning service with multiple boards/templates; tracked links and CSV exports. Direct Beacons conversion writes unavailable. |
| Deployment | Deployed 2026-10-10 | Ten private domain Workers, gateway and Pages published; all ten database migrations completed; ingress/cron/nine consumer queues resumed. |

Provider connections require genuine credentials and supported provider APIs.
No existing student is automatically emailed or charged during rollout.

## Integration evidence

- Source reviews covered student/guardian/scoped tutor authorization, private
  resources, invitation/merge locking, event revisions, provider identity and
  financial visibility. Identified issues were fixed before rollout.
- Full workspace typecheck, production frontend/service build, Worker/Pages
  bundling and ten-service import-boundary checks passed.
- All ten local services started and applied their additive migrations.
- No automated tests or end-to-end customer/provider flows were run in this task.
- Automatic invitation/recovery email still requires a configured system sender.
  Failed delivery is explicit and fresh manual invitation links are available.
- Protected student records deliberately cannot be merged after portal invitation
  protection. A future reviewed revoke/unlock workflow is required.
- Enterprise licensing/admin, real payment activation, Google OAuth document
  creation and verified Beacons conversion ingestion are not implemented.

## Release receipt

- Architecture was committed/pushed before implementation (`f0dc4cf`), followed by
  CRM/policy (`900756d`), groups/invitations (`a2244ba`) and the integrated services
  and UI (`a2a3cbc`). Branch: `feat/student-workspace`.
- Existing data was archived before migrations: 68 tables across eight original
  service databases, with applied migrations/catalog metadata in an ignored
  private recovery directory. All ten service migrations then completed using
  ordinary isolated roles. No replacement/import of existing records occurred.
- Cloudflare published all ten services, gateway and Pages. Maintenance was
  explicitly resumed with background controls restored. No hosting plan upgrade.
- Live readback: `/health`, `/`, `/portal`, `/portal/invite` and the unauthenticated
  session endpoint returned HTTP 200. Browser document navigation to the default
  Pages `/portal` returned 308 to `https://tuts.palladiumscholars.com/portal`.
- These availability checks do not establish authenticated end-to-end behavior
  or external provider delivery. No automatic test suite was run.

## First use

Refresh the app. Use **Student tracker** to organize groups and choose students,
then issue a portal invitation to a designated contact. Until a sender is
configured, share the fresh manual link returned by the invitation action.
Use **Reconcile students on this page** to load historical summary data.
**Student boards** opens the new Planning service. **Connectors** contains student
Cal.com booking settings and Beacons tagged links/exports. Existing Cal.com
connections can be selected; provider webhook registration is an explicit
setup step in Cal.com.
