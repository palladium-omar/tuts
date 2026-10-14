# Google Calendar privacy follow-up — October 14, 2026

## Finding

Google Trust & Safety contacted the project `911313055472` (`palladiumscholars-firebase`). The reviewer says the privacy policy does not explain with whom Google user data is shared, transferred, or disclosed, and does not specify the mechanisms used to protect sensitive data. This is a remediation record; it is not evidence that the notice has been updated, deployed, or accepted.

The October 12 submission record describes Cloudflare and Neon PostgreSQL as processors, workspace staff access, optional attendee-to-CRM import, encrypted credentials, and deletion behavior. Those are recorded implementation claims, not a substitute for checking the current code, deployment configuration, contracts, and retention behavior before publishing revised wording. In particular, verify every recipient, data category, purpose, protection mechanism, and deletion/retention statement against the live implementation. Record any discrepancy and avoid promising protections or timelines the system does not enforce.

## Remediation recorded in the notice

Keep the canonical public privacy URL stable at <https://tuts.palladiumscholars.com/privacy>. The updated source now has these explicit anchors for reviewer links:

- `#google-data-sharing` — named workspace recipients and their purposes: the connected business and authorized users, Cloudflare, Neon, Google, and conditional messaging providers (Resend/configured SMTP or Meta WhatsApp when the business activates those features). The disclosure also covers exports initiated by authorized staff and states that connecting Calendar alone does not message attendees.
- `#google-data-protection` — HTTPS/TLS, AES-256-GCM with business-ID associated data for stored credentials, Neon AES-256 at-rest encryption, access controls and tenant isolation, signed expiring internal authorization contexts, and credential/log redaction.

The public source states these protections precisely: session records and sync snapshots are access-controlled workspace records, not claimed as application-level encrypted; Neon documents AES-256 encryption at rest. The notice retains the distinction between disconnect cleanup for connector credentials/snapshots/session projections and separately retained CRM contacts. The auditor reviewed the updated text and found no material unsupported claims. This record documents source review, not public deployment.

| Disclosure claim | Implementation/evidence reference |
| --- | --- |
| Credential encryption and workspace binding | `services/integrations/src/security.ts` (`aes-256-gcm`, business ID AAD); `services/integrations/src/google-calendar.ts` (credentials and private feed URL encrypted before persistence) |
| Tenant isolation and access authorization | `services/integrations/migrations/005_google_calendar.sql` (forced RLS on OAuth-state and snapshot tables); `packages/service-kit/src/auth.ts` (signed context verification and expiry); Google Calendar connection handlers in `services/integrations/src/google-calendar.ts` |
| Public connection views and diagnostic redaction | `services/integrations/src/connection-view.ts`; `packages/service-kit/src/diagnostics.ts`; `services/integrations/src/security.ts` |
| Disconnect and downstream session cleanup | `services/integrations/src/connections.ts`; `services/scheduling/src/external-sessions.ts` |
| Provider recipients and activated delivery paths | `services/integrations/src/google-calendar-provider.ts`; `services/notifications/src/` provider adapters; the public policy's conditional delivery disclosure |
| Database encryption at rest | [Neon security overview](https://neon.com/docs/security/security-overview) |
| Exact public wording and anchors | `apps/web/app/privacy/page.tsx` (`#google-data-sharing`, `#google-data-protection`) |

## Review and reply sequence

Google's published guidance says to update the privacy policy at the same URL and reply to the existing verification email when fixes are complete: [Google Cloud OAuth verification FAQ](https://support.google.com/cloud/answer/13806988?hl=en). If the current Google Cloud Console offers a resubmission/update action, follow that workflow without cancelling the existing review. Do not interpret this record as a submitted response or a renewed approval.

## Status — pending receipts

- Privacy notice content change: prepared in the current workspace; live deployment/readback pending.
- Security, recipient, and retention claim verification: implementation source review recorded; auditor found no material unsupported claims. Production deployment remains pending.
- Public deployment and stable-URL readback: pending.
- Reply to the existing verification email or console follow-up: pending.
- Google review status/decision: pending; no approval is claimed.

After remediation, attach dated evidence for the deployed page/readback and the sent response or console receipt. Keep this record updated with the actual outcome. Add an annual review check for the disclosed recipients, protection mechanisms, and retention/deletion behavior so the notice remains aligned with implementation.
