# Student workspace delivery

Architecture: [accepted implementation contract](architecture/student-workspace.md).

| Phase | Status | Evidence / limitations |
| --- | --- | --- |
| Architecture and scope | Documented | Existing Cloudflare/Neon deployment; capability-based account scope; enterprise provisioning deferred |
| 1. CRM and permission foundation | Implemented, awaiting full rollout | Additive contacts/merge migration; explicit import review; scoped capability context; Clients/Platform builds, web typecheck and service import boundary check passed. Runtime flows pending. |
| 2. Groups and invitations | Implemented, awaiting full rollout | Scoped groups and safe student directory; invitation lifecycle and shared account form; Platform/Notifications/Clients builds pass. Sender remains unconfigured; invitation delivery failures and fresh manual links are explicit. |
| 3. Student portal and Cal.com | Implemented, awaiting rollout | Scoped homework/submissions/resources, private files, Google Docs references, Cal.com booking links and signed canonical sync; explicit attendance. |
| 4. Reporting and money | Implemented, awaiting rollout | Separate Reporting service, source reconciliation/coverage, active-time estimates, scoped financial history and real/simulated currency totals. |
| 5. Planning and attribution | Implemented, awaiting rollout | Separate Planning service with multiple boards/templates; tracked links and CSV exports. Direct Beacons conversion writes unavailable. |
| Deployment | Pending | |

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
