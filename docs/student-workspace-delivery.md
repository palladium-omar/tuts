# Student workspace delivery

Architecture: [accepted implementation contract](architecture/student-workspace.md).

| Phase | Status | Evidence / limitations |
| --- | --- | --- |
| Architecture and scope | Documented | Existing Cloudflare/Neon deployment; capability-based account scope; enterprise provisioning deferred |
| 1. CRM and permission foundation | Implemented, awaiting full rollout | Additive contacts/merge migration; explicit import review; scoped capability context; Clients/Platform builds, web typecheck and service import boundary check passed. Runtime flows pending. |
| 2. Groups and invitations | Implemented, awaiting full rollout | Scoped groups and safe student directory; invitation lifecycle and shared account form; Platform/Notifications/Clients builds pass. Sender remains unconfigured; invitation delivery failures and fresh manual links are explicit. |
| 3. Student portal and Cal.com | In progress | Dedicated portal APIs, private learning resources and signed calendar updates. |
| 4. Reporting and money | Pending | |
| 5. Planning and attribution | Pending | |
| Deployment | Pending | |

Provider connections require genuine credentials and supported provider APIs.
No existing student is automatically emailed or charged during rollout.
