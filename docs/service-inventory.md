# Service API and database inventory

Generated from controller declarations and SQL migrations by `node scripts/document-service-inventory.mjs`. This is a route and ownership inventory, not a complete OpenAPI schema or proof of runtime access. Zod schemas in each service define request validation. Read [HTTP](architecture/http.md), [security](architecture/security.md), and the service README before integration.

Gateway adds `/api/{service}` to each domain path. `@Public` means the shared session-context guard is bypassed; provider/internal routes still require their own secrets or signatures. Omitted roles default to staff under the shared guard; student routes also need explicit resource checks. Class and method metadata are shown together, so consult controller code for overrides. `/health` is shared. The declared `/openapi.json` endpoint currently returns 404 in the audited Node runtime; see audit finding A-03.

Only the owning service may read or write the tables below. Runtime-owned `service_migrations`, `service_outbox`, and `service_inbox` exist in each database and are omitted from the domain lists.

## platform

Local port: 4001. [Service guide](../services/platform/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| ALL | `/auth/*path` | Public | [AuthController.handle](../services/platform/src/auth.controller.ts#L16) |
| GET | `/v1/session` | Public | [BusinessesController.session](../services/platform/src/businesses.controller.ts#L75) |
| POST | `/v1/client-diagnostics` | Public | [BusinessesController.clientDiagnostics](../services/platform/src/businesses.controller.ts#L86) |
| GET | `/v1/businesses` | Public | [BusinessesController.list](../services/platform/src/businesses.controller.ts#L108) |
| GET | `/v1/bootstrap` | Public | [BusinessesController.bootstrap](../services/platform/src/businesses.controller.ts#L117) |
| POST | `/v1/businesses` | Public | [BusinessesController.create](../services/platform/src/businesses.controller.ts#L150) |
| PATCH | `/v1/businesses/:businessId/settings` | Public | [BusinessesController.settings](../services/platform/src/businesses.controller.ts#L210) |
| POST | `/internal/context` | Public | [ContextController.context](../services/platform/src/businesses.controller.ts#L270) |
| GET | `/v1/portal/sender-status` | Public | [PortalController.senderStatus](../services/platform/src/portal.controller.ts#L17) |
| GET | `/v1/portal/invitations` | Public | [PortalController.list](../services/platform/src/portal.controller.ts#L25) |
| POST | `/v1/portal/invitations` | Public | [PortalController.create](../services/platform/src/portal.controller.ts#L32) |
| POST | `/v1/portal/invitations/:id/resend` | Public | [PortalController.resend](../services/platform/src/portal.controller.ts#L40) |
| DELETE | `/v1/portal/invitations/:id` | Public | [PortalController.revokeInvitation](../services/platform/src/portal.controller.ts#L50) |
| POST | `/v1/portal/accept` | Public | [PortalController.accept](../services/platform/src/portal.controller.ts#L59) |
| GET | `/v1/portal/access` | Public | [PortalController.access](../services/platform/src/portal.controller.ts#L69) |
| DELETE | `/v1/portal/access/:id` | Public | [PortalController.revokeAccess](../services/platform/src/portal.controller.ts#L76) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_identity.sql](../services/platform/migrations/001_identity.sql) | `"user"`, `"session"`, `"account"`, `"verification"` |
| [002_businesses.sql](../services/platform/migrations/002_businesses.sql) | `businesses`, `memberships`, `identity_business_directory` |
| [003_business_profile.sql](../services/platform/migrations/003_business_profile.sql) | Alters existing schema/policies |
| [004_auth_rate_limit.sql](../services/platform/migrations/004_auth_rate_limit.sql) | `"rateLimit"` |
| [005_capability_policy.sql](../services/platform/migrations/005_capability_policy.sql) | `portal_student_access` |
| [006_portal_invitations.sql](../services/platform/migrations/006_portal_invitations.sql) | `portal_invitations`, `portal_access_audit` |
| [007_student_workspace_features.sql](../services/platform/migrations/007_student_workspace_features.sql) | Alters existing schema/policies |

## clients

Local port: 4002. [Service guide](../services/clients/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/clients/student-stats` | Roles(owner, admin, tutor); Permissions(clients.read) | [ClientsController.studentStats](../services/clients/src/clients.controller.ts#L50) |
| GET | `/v1/clients` | Roles(owner, admin, tutor); Permissions(clients.read) | [ClientsController.list](../services/clients/src/clients.controller.ts#L67) |
| POST | `/v1/clients` | Roles(owner, admin, tutor); Permissions(clients.write) | [ClientsController.create](../services/clients/src/clients.controller.ts#L94) |
| GET | `/v1/clients/:id` | Roles(owner, admin, tutor); Permissions(clients.read) | [ClientsController.get](../services/clients/src/clients.controller.ts#L109) |
| PATCH | `/v1/clients/:id` | Roles(owner, admin, tutor); Permissions(clients.write) | [ClientsController.update](../services/clients/src/clients.controller.ts#L119) |
| DELETE | `/v1/clients/:id` | Roles(owner, admin, tutor); Permissions(clients.write); Roles(owner, admin) | [ClientsController.remove](../services/clients/src/clients.controller.ts#L139) |
| GET | `/v1/clients/:id/payers` | Roles(owner, admin, tutor); Permissions(clients.read) | [ClientsController.payers](../services/clients/src/clients.controller.ts#L172) |
| POST | `/v1/clients/:id/payers` | Roles(owner, admin, tutor); Permissions(clients.write) | [ClientsController.linkPayer](../services/clients/src/clients.controller.ts#L201) |
| GET | `/v1/fields` | Roles(owner, admin, tutor); Permissions(clients.read) | [FieldsController.list](../services/clients/src/fields.controller.ts#L37) |
| POST | `/v1/fields` | Roles(owner, admin, tutor); Permissions(clients.write); Roles(owner, admin) | [FieldsController.create](../services/clients/src/fields.controller.ts#L44) |
| PATCH | `/v1/fields/:id` | Roles(owner, admin, tutor); Permissions(clients.write); Roles(owner, admin) | [FieldsController.update](../services/clients/src/fields.controller.ts#L77) |
| GET | `/v1/groups` | Roles(owner, admin, tutor); StudentScoped; Permissions(clients.read) | [GroupsController.list](../services/clients/src/groups.controller.ts#L26) |
| POST | `/v1/groups` | Roles(owner, admin, tutor); Permissions(clients.groups.manage) | [GroupsController.create](../services/clients/src/groups.controller.ts#L48) |
| GET | `/v1/groups/:id` | Roles(owner, admin, tutor); StudentScoped; Permissions(clients.read) | [GroupsController.get](../services/clients/src/groups.controller.ts#L70) |
| PATCH | `/v1/groups/:id` | Roles(owner, admin, tutor); Permissions(clients.groups.manage) | [GroupsController.update](../services/clients/src/groups.controller.ts#L94) |
| DELETE | `/v1/groups/:id` | Roles(owner, admin, tutor); Permissions(clients.groups.manage) | [GroupsController.remove](../services/clients/src/groups.controller.ts#L119) |
| GET | `/v1/groups/:id/members` | Roles(owner, admin, tutor); StudentScoped; Permissions(clients.read) | [GroupsController.members](../services/clients/src/groups.controller.ts#L144) |
| POST | `/v1/groups/:id/members` | Roles(owner, admin, tutor); Permissions(clients.groups.manage) | [GroupsController.add](../services/clients/src/groups.controller.ts#L169) |
| DELETE | `/v1/groups/:id/members` | Roles(owner, admin, tutor); Permissions(clients.groups.manage) | [GroupsController.removeMembers](../services/clients/src/groups.controller.ts#L180) |
| GET | `/v1/clients/:id/contacts` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.read) | [IdentityController.contacts](../services/clients/src/identity.controller.ts#L38) |
| POST | `/v1/clients/:id/contacts` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.write) | [IdentityController.add](../services/clients/src/identity.controller.ts#L51) |
| PATCH | `/v1/clients/:id/contacts/:contactId` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.write) | [IdentityController.edit](../services/clients/src/identity.controller.ts#L69) |
| DELETE | `/v1/clients/:id/contacts/:contactId` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.write) | [IdentityController.detach](../services/clients/src/identity.controller.ts#L91) |
| GET | `/v1/duplicates` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.read) | [IdentityController.duplicates](../services/clients/src/identity.controller.ts#L122) |
| POST | `/v1/duplicates/dismiss` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.write) | [IdentityController.dismiss](../services/clients/src/identity.controller.ts#L151) |
| POST | `/v1/merges/preview` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.merge) | [IdentityController.preview](../services/clients/src/identity.controller.ts#L174) |
| POST | `/v1/merges` | StudentScoped; Roles(owner, admin, tutor); Permissions(clients.merge) | [IdentityController.commit](../services/clients/src/identity.controller.ts#L191) |
| POST | `/v1/imports/parse` | Roles(owner, admin, tutor); Permissions(clients.write) | [ImportsController.parse](../services/clients/src/imports.controller.ts#L33) |
| POST | `/v1/imports/preview` | Roles(owner, admin, tutor); Permissions(clients.write) | [ImportsController.preview](../services/clients/src/imports.controller.ts#L59) |
| POST | `/v1/imports/commit` | Roles(owner, admin, tutor); Permissions(clients.write) | [ImportsController.commit](../services/clients/src/imports.controller.ts#L71) |
| POST | `/internal/portal-students` | Public | [PortalInternalController.student](../services/clients/src/portal-internal.controller.ts#L16) |
| GET | `/v1/portal/students` | StudentScoped; Permissions(clients.read) | [PortalStudentsController.list](../services/clients/src/portal-students.controller.ts#L20) |
| GET | `/v1/portal/students/:id` | StudentScoped; Permissions(clients.read) | [PortalStudentsController.get](../services/clients/src/portal-students.controller.ts#L40) |
| POST | `/v1/recipients` | Roles(owner, admin, tutor); Permissions(clients.write) | [RecipientsController.resolve](../services/clients/src/recipients.controller.ts#L18) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_clients.sql](../services/clients/migrations/001_clients.sql) | `clients`, `client_payers` |
| [002_crm.sql](../services/clients/migrations/002_crm.sql) | `client_import_requests`, `client_external_sources` |
| [003_disconnected_sources.sql](../services/clients/migrations/003_disconnected_sources.sql) | `disconnected_client_sources` |
| [004_custom_fields.sql](../services/clients/migrations/004_custom_fields.sql) | `client_fields` |
| [005_student_identity.sql](../services/clients/migrations/005_student_identity.sql) | `related_contacts`, `contact_addresses`, `student_contacts`, `duplicate_dismissals`, `student_merge_audit` |
| [006_student_groups.sql](../services/clients/migrations/006_student_groups.sql) | `student_groups`, `student_group_members` |
| [007_student_planning_profile.sql](../services/clients/migrations/007_student_planning_profile.sql) | Alters existing schema/policies |

## scheduling

Local port: 4003. [Service guide](../services/scheduling/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/class-ledger` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.read) | [ClassLedgerController.list](../services/scheduling/src/class-ledger.ts#L122) |
| PATCH | `/v1/class-ledger/:source/:id` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.write) | [ClassLedgerController.annotate](../services/scheduling/src/class-ledger.ts#L175) |
| GET | `/v1/external-sessions` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.read) | [ExternalSessionsController.list](../services/scheduling/src/external-sessions.ts#L228) |
| GET | `/v1/portal/sessions` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(scheduling.read) | [PortalSessionsController.sessions](../services/scheduling/src/portal-sessions.ts#L62) |
| GET | `/v1/portal/classes` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(scheduling.read) | [PortalSessionsController.classes](../services/scheduling/src/portal-sessions.ts#L64) |
| GET | `/v1/sessions` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.read) | [SessionsController.list](../services/scheduling/src/sessions.ts#L275) |
| POST | `/v1/sessions` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.write) | [SessionsController.create](../services/scheduling/src/sessions.ts#L290) |
| PATCH | `/v1/sessions/:id` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.write) | [SessionsController.update](../services/scheduling/src/sessions.ts#L306) |
| POST | `/v1/sessions/:id/cancel` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.write) | [SessionsController.cancel](../services/scheduling/src/sessions.ts#L324) |
| POST | `/v1/sessions/:id/complete` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.write) | [SessionsController.complete](../services/scheduling/src/sessions.ts#L330) |
| POST | `/v1/sessions/:id/no-show` | Roles(owner, admin, tutor); StudentScoped; Permissions(scheduling.write) | [SessionsController.noShow](../services/scheduling/src/sessions.ts#L336) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_sessions.sql](../services/scheduling/migrations/001_sessions.sql) | `sessions` |
| [002_external_sessions.sql](../services/scheduling/migrations/002_external_sessions.sql) | `external_sessions`, `disconnected_session_sources` |
| [003_class_ledger.sql](../services/scheduling/migrations/003_class_ledger.sql) | `class_annotations`, `class_ledger` |
| [004_portal_attendance.sql](../services/scheduling/migrations/004_portal_attendance.sql) | `scheduling_student_aliases` |

## learning

Local port: 4004. [Service guide](../services/learning/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/assignments` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.read) | [AssignmentsController.list](../services/learning/src/learning.ts#L19) |
| GET | `/v1/assignments/:id` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.read) | [AssignmentsController.get](../services/learning/src/learning.ts#L27) |
| POST | `/v1/assignments/:id/submission-upload` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.write) | [AssignmentsController.uploadSubmission](../services/learning/src/learning.ts#L33) |
| POST | `/v1/assignments` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.write) | [AssignmentsController.create](../services/learning/src/learning.ts#L39) |
| POST | `/v1/assignments/:id/submit` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.write) | [AssignmentsController.submit](../services/learning/src/learning.ts#L66) |
| POST | `/v1/assignments/:id/review` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.write) | [AssignmentsController.review](../services/learning/src/learning.ts#L96) |
| GET | `/v1/resources/:id` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.read) | [ResourcesController.get](../services/learning/src/learning.ts#L128) |
| GET | `/v1/resources` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.read) | [ResourcesController.list](../services/learning/src/learning.ts#L131) |
| POST | `/v1/resources/upload` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.write) | [ResourcesController.upload](../services/learning/src/learning.ts#L141) |
| GET | `/v1/resources/:id/download` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.read) | [ResourcesController.download](../services/learning/src/learning.ts#L177) |
| POST | `/v1/resources` | StudentScoped; Roles(owner, admin, tutor); Permissions(learning.write) | [ResourcesController.create](../services/learning/src/learning.ts#L190) |
| GET | `/v1/portal/assignments` | StudentScoped; Permissions(learning.read) | [PortalLearningController.list](../services/learning/src/portal.controller.ts#L26) |
| GET | `/v1/portal/assignments/:id` | StudentScoped; Permissions(learning.read) | [PortalLearningController.get](../services/learning/src/portal.controller.ts#L35) |
| POST | `/v1/portal/assignments/:id/submit` | StudentScoped; Permissions(learning.write) | [PortalLearningController.submit](../services/learning/src/portal.controller.ts#L44) |
| POST | `/v1/portal/assignments/:id/submission-upload` | StudentScoped; Permissions(learning.write) | [PortalLearningController.upload](../services/learning/src/portal.controller.ts#L55) |
| GET | `/v1/portal/resources` | StudentScoped; Permissions(learning.read) | [PortalLearningController.resources](../services/learning/src/portal.controller.ts#L73) |
| GET | `/v1/portal/resources/capabilities` | StudentScoped; Permissions(learning.read) | [PortalLearningController.capabilities](../services/learning/src/portal.controller.ts#L82) |
| GET | `/v1/portal/resources/:id` | StudentScoped; Permissions(learning.read) | [PortalLearningController.resource](../services/learning/src/portal.controller.ts#L95) |
| GET | `/v1/portal/resources/:id/download` | StudentScoped; Permissions(learning.read) | [PortalLearningController.download](../services/learning/src/portal.controller.ts#L104) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_learning.sql](../services/learning/migrations/001_learning.sql) | `resources`, `assignments`, `assignment_resources` |
| [002_resource_uploads.sql](../services/learning/migrations/002_resource_uploads.sql) | Alters existing schema/policies |
| [003_portal_learning.sql](../services/learning/migrations/003_portal_learning.sql) | `assignment_submission_resources`, `learning_student_aliases` |

## billing

Local port: 4005. [Service guide](../services/billing/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/invoices` | Roles(owner, admin, tutor) | [BillingController.list](../services/billing/src/billing.ts#L258) |
| GET | `/v1/invoices/:id` | Roles(owner, admin, tutor) | [BillingController.get](../services/billing/src/billing.ts#L261) |
| POST | `/v1/invoices` | Roles(owner, admin, tutor) | [BillingController.create](../services/billing/src/billing.ts#L267) |
| POST | `/v1/invoices/:id/issue` | Roles(owner, admin, tutor) | [BillingController.issue](../services/billing/src/billing.ts#L310) |
| POST | `/v1/history-imports/preview` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial); Permissions(billing.read, reporting.financial, billing.write) | [HistoryImportsController.preview](../services/billing/src/history.controller.ts#L16) |
| POST | `/v1/history-imports/commit` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial); Permissions(billing.read, reporting.financial, billing.write) | [HistoryImportsController.commit](../services/billing/src/history.controller.ts#L20) |
| GET | `/v1/history-imports` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial) | [HistoryImportsController.list](../services/billing/src/history.controller.ts#L23) |
| GET | `/v1/history-imports/:id/download` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial) | [HistoryImportsController.download](../services/billing/src/history.controller.ts#L24) |
| PATCH | `/v1/work-log/:id/identity` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial); Permissions(billing.read, reporting.financial, billing.write) | [WorkLogController.identity](../services/billing/src/history.controller.ts#L35) |
| GET | `/v1/work-log` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial) | [WorkLogController.list](../services/billing/src/history.controller.ts#L37) |
| GET | `/v1/work-log/summary` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial) | [WorkLogController.summary](../services/billing/src/history.controller.ts#L38) |
| PATCH | `/v1/work-log/:id` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial); Permissions(billing.read, reporting.financial, billing.write) | [WorkLogController.edit](../services/billing/src/history.controller.ts#L39) |
| GET | `/v1/invoice-history` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial) | [InvoiceHistoryController.list](../services/billing/src/history.controller.ts#L47) |
| POST | `/v1/invoice-history` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial); Permissions(billing.read, reporting.financial, billing.write) | [InvoiceHistoryController.create](../services/billing/src/history.controller.ts#L48) |
| PATCH | `/v1/invoice-history/:id` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial); Permissions(billing.read, reporting.financial, billing.write) | [InvoiceHistoryController.edit](../services/billing/src/history.controller.ts#L50) |
| GET | `/v1/business-analytics` | Roles(owner, admin, tutor); Permissions(billing.read, reporting.financial) | [BusinessAnalyticsController.get](../services/billing/src/history.controller.ts#L58) |
| GET | `/v1/billing-settings` | Roles(owner, admin, tutor) | [MonthlyController.settings](../services/billing/src/monthly.ts#L692) |
| PUT | `/v1/billing-settings` | Roles(owner, admin, tutor); Roles(owner, admin) | [MonthlyController.saveSettings](../services/billing/src/monthly.ts#L699) |
| GET | `/v1/student-rates` | Roles(owner, admin, tutor) | [MonthlyController.rates](../services/billing/src/monthly.ts#L709) |
| POST | `/v1/student-rates` | Roles(owner, admin, tutor); Roles(owner, admin) | [MonthlyController.createRate](../services/billing/src/monthly.ts#L716) |
| PATCH | `/v1/student-rates/:id` | Roles(owner, admin, tutor); Roles(owner, admin) | [MonthlyController.updateRate](../services/billing/src/monthly.ts#L726) |
| POST | `/v1/monthly/reconcile` | Roles(owner, admin, tutor) | [MonthlyController.reconcile](../services/billing/src/monthly.ts#L738) |
| GET | `/v1/monthly/preview` | Roles(owner, admin, tutor) | [MonthlyController.preview](../services/billing/src/monthly.ts#L749) |
| POST | `/v1/monthly/generate` | Roles(owner, admin, tutor); Roles(owner, admin) | [MonthlyController.generate](../services/billing/src/monthly.ts#L758) |
| GET | `/v1/dashboard` | Roles(owner, admin, tutor) | [MonthlyController.dashboard](../services/billing/src/monthly.ts#L768) |
| GET | `/v1/portal/finance` | Roles(owner, admin, tutor); StudentScoped; Permissions(billing.read) | [StudentFinanceController.get](../services/billing/src/student-finance.ts#L68) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_billing.sql](../services/billing/migrations/001_billing.sql) | `invoices`, `payment_allocations`, `billing_idempotency` |
| [002_seller_snapshots.sql](../services/billing/migrations/002_seller_snapshots.sql) | `business_seller_profiles` |
| [003_monthly_billing.sql](../services/billing/migrations/003_monthly_billing.sql) | `billing_settings`, `student_rates`, `billing_classes`, `billed_classes`, `monthly_reconciliations` |
| [004_reconciliation_presence.sql](../services/billing/migrations/004_reconciliation_presence.sql) | Alters existing schema/policies |
| [005_attendance_status.sql](../services/billing/migrations/005_attendance_status.sql) | Alters existing schema/policies |
| [006_student_finance.sql](../services/billing/migrations/006_student_finance.sql) | `billing_student_aliases` |
| [007_business_history.sql](../services/billing/migrations/007_business_history.sql) | `billing_history_sources`, `billing_work_log`, `billing_invoice_history` |
| [008_history_identity.sql](../services/billing/migrations/008_history_identity.sql) | `billing_work_identities` |

## payments

Local port: 4006. [Service guide](../services/payments/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/providers` | Roles(owner, admin, tutor) | [PaymentsController.providers](../services/payments/src/payments.ts#L405) |
| GET | `/v1/connections` | Roles(owner, admin, tutor) | [PaymentsController.connections](../services/payments/src/payments.ts#L409) |
| POST | `/v1/connections` | Roles(owner, admin, tutor); Roles(owner, admin) | [PaymentsController.createConnection](../services/payments/src/payments.ts#L416) |
| POST | `/v1/connections/:id/verify` | Roles(owner, admin, tutor); Roles(owner, admin) | [PaymentsController.verify](../services/payments/src/payments.ts#L454) |
| DELETE | `/v1/connections/:id` | Roles(owner, admin, tutor); Roles(owner, admin) | [PaymentsController.disable](../services/payments/src/payments.ts#L464) |
| POST | `/v1/checkouts/:id/refresh` | Roles(owner, admin, tutor); Roles(owner, admin) | [PaymentsController.refresh](../services/payments/src/payments.ts#L474) |
| GET | `/v1/checkouts` | Roles(owner, admin, tutor) | [PaymentsController.list](../services/payments/src/payments.ts#L484) |
| GET | `/v1/checkouts/:id` | Roles(owner, admin, tutor) | [PaymentsController.get](../services/payments/src/payments.ts#L491) |
| POST | `/v1/checkouts` | Roles(owner, admin, tutor); Roles(owner, admin) | [PaymentsController.create](../services/payments/src/payments.ts#L500) |
| POST | `/v1/checkouts/:id/sandbox-confirm` | Roles(owner, admin, tutor) | [PaymentsController.confirm](../services/payments/src/payments.ts#L527) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_payments.sql](../services/payments/migrations/001_payments.sql) | `payment_connections`, `invoice_snapshots`, `payment_attempts`, `provider_events`, `payments_idempotency` |
| [002_stripe_test.sql](../services/payments/migrations/002_stripe_test.sql) | `stripe_checkout_sessions` |

## notifications

Local port: 4007. [Service guide](../services/notifications/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/internal/auth-mail/status` | Public | [AuthMailController.status](../services/notifications/src/auth-mail.ts#L132) |
| POST | `/internal/auth-mail/password-reset` | Public | [AuthMailController.sendPasswordReset](../services/notifications/src/auth-mail.ts#L138) |
| POST | `/internal/auth-mail/portal-invitation` | Public | [AuthMailController.sendPortalInvitation](../services/notifications/src/auth-mail.ts#L154) |
| GET | `/v1/communication-connections` | Roles(owner, admin, tutor) | [CommunicationConnectionsController.list](../services/notifications/src/communications.ts#L703) |
| POST | `/v1/communication-connections` | Roles(owner, admin, tutor); Roles(owner, admin) | [CommunicationConnectionsController.create](../services/notifications/src/communications.ts#L710) |
| PATCH | `/v1/communication-connections/:id` | Roles(owner, admin, tutor); Roles(owner, admin) | [CommunicationConnectionsController.patch](../services/notifications/src/communications.ts#L720) |
| DELETE | `/v1/communication-connections/:id` | Roles(owner, admin, tutor); Roles(owner, admin) | [CommunicationConnectionsController.disable](../services/notifications/src/communications.ts#L732) |
| POST | `/v1/communication-connections/:id/generate` | Roles(owner, admin, tutor) | [CommunicationConnectionsController.generate](../services/notifications/src/communications.ts#L742) |
| GET | `/v1/campaigns` | Roles(owner, admin, tutor) | [CampaignsController.list](../services/notifications/src/communications.ts#L762) |
| GET | `/v1/campaigns/:id` | Roles(owner, admin, tutor) | [CampaignsController.get](../services/notifications/src/communications.ts#L769) |
| POST | `/v1/campaigns` | Roles(owner, admin, tutor); Roles(owner, admin) | [CampaignsController.create](../services/notifications/src/communications.ts#L778) |
| POST | `/v1/campaigns/:id/send` | Roles(owner, admin, tutor); Roles(owner, admin) | [CampaignsController.send](../services/notifications/src/communications.ts#L790) |
| POST | `/v1/campaigns/:id/cancel` | Roles(owner, admin, tutor); Roles(owner, admin) | [CampaignsController.cancel](../services/notifications/src/communications.ts#L802) |
| GET | `/v1/notifications` | Roles(owner, admin, tutor) | [NotificationsController.list](../services/notifications/src/notifications.ts#L52) |
| POST | `/v1/notifications` | Roles(owner, admin, tutor) | [NotificationsController.create](../services/notifications/src/notifications.ts#L55) |
| PATCH | `/v1/notifications/:id` | Roles(owner, admin, tutor) | [NotificationsController.update](../services/notifications/src/notifications.ts#L58) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_notifications.sql](../services/notifications/migrations/001_notifications.sql) | `notifications` |
| [002_communications.sql](../services/notifications/migrations/002_communications.sql) | `communication_connections`, `communication_campaigns`, `communication_recipients`, `communication_consent` |

## integrations

Local port: 4008. [Service guide](../services/integrations/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/connections` | Roles(owner, admin, tutor) | [ConnectionsController.list](../services/integrations/src/connections.ts#L642) |
| GET | `/v1/connections/:id` | Roles(owner, admin, tutor) | [ConnectionsController.one](../services/integrations/src/connections.ts#L645) |
| POST | `/v1/connections` | Roles(owner, admin, tutor); Roles(owner, admin) | [ConnectionsController.create](../services/integrations/src/connections.ts#L651) |
| PATCH | `/v1/connections/:id` | Roles(owner, admin, tutor); Roles(owner, admin) | [ConnectionsController.update](../services/integrations/src/connections.ts#L657) |
| POST | `/v1/connections/:id/sync` | Roles(owner, admin, tutor); Roles(owner, admin) | [ConnectionsController.sync](../services/integrations/src/connections.ts#L664) |
| POST | `/v1/connections/:id/calcom-webhook` | Roles(owner, admin, tutor); Roles(owner, admin); Permissions(integrations.manage) | [ConnectionsController.configureCalWebhook](../services/integrations/src/connections.ts#L670) |
| DELETE | `/v1/connections/:id` | Roles(owner, admin, tutor); Roles(owner, admin) | [ConnectionsController.disconnect](../services/integrations/src/connections.ts#L674) |
| POST | `/hooks/:businessId/:connectionId` | Public | [FormHooksController.receive](../services/integrations/src/connections.ts#L687) |
| GET | `/v1/portal/booking` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(integrations.read, scheduling.read) | [PortalBookingController.booking](../services/integrations/src/portal-booking.ts#L90) |
| GET | `/v1/portal/booking-config` | StudentScoped; Roles(owner, admin, tutor); Permissions(integrations.read) | [PortalBookingController.own](../services/integrations/src/portal-booking.ts#L93) |
| PUT | `/v1/portal/booking-config` | StudentScoped; Roles(owner, admin, tutor); Permissions(integrations.write) | [PortalBookingController.configure](../services/integrations/src/portal-booking.ts#L95) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_connections.sql](../services/integrations/migrations/001_connections.sql) | `integration_tenant_directory`, `integration_connections` |
| [002_import_result.sql](../services/integrations/migrations/002_import_result.sql) | Alters existing schema/policies |
| [003_dispatch_entitlements.sql](../services/integrations/migrations/003_dispatch_entitlements.sql) | Alters existing schema/policies |
| [004_portal_booking.sql](../services/integrations/migrations/004_portal_booking.sql) | `portal_booking_configs`, `cal_webhook_receipts` |

## planning

Local port: 4009. [Service guide](../services/planning/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/templates` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.read) | [PlanningController.templates](../services/planning/src/planning.controller.ts#L11) |
| GET | `/v1/templates/:key` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.read) | [PlanningController.template](../services/planning/src/planning.controller.ts#L14) |
| POST | `/v1/templates` | StudentScoped; Roles(owner, admin, tutor, student, parent); Roles(owner, admin, tutor); Permissions(planning.write) | [PlanningController.publish](../services/planning/src/planning.controller.ts#L17) |
| POST | `/v1/templates/:key/instantiate` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write, clients.read) | [PlanningController.instantiate](../services/planning/src/planning.controller.ts#L20) |
| GET | `/v1/boards` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.read) | [PlanningController.boards](../services/planning/src/planning.controller.ts#L23) |
| POST | `/v1/boards` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write, clients.read) | [PlanningController.createBoard](../services/planning/src/planning.controller.ts#L26) |
| GET | `/v1/boards/:id` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.read) | [PlanningController.board](../services/planning/src/planning.controller.ts#L29) |
| PATCH | `/v1/boards/:id` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.updateBoard](../services/planning/src/planning.controller.ts#L32) |
| DELETE | `/v1/boards/:id` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.deleteBoard](../services/planning/src/planning.controller.ts#L35) |
| POST | `/v1/boards/:id/columns` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.createColumn](../services/planning/src/planning.controller.ts#L38) |
| PATCH | `/v1/boards/:id/columns/:columnId` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.updateColumn](../services/planning/src/planning.controller.ts#L41) |
| DELETE | `/v1/boards/:id/columns/:columnId` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.deleteColumn](../services/planning/src/planning.controller.ts#L44) |
| GET | `/v1/boards/:id/cards` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.read) | [PlanningController.cards](../services/planning/src/planning.controller.ts#L47) |
| POST | `/v1/boards/:id/cards` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.createCard](../services/planning/src/planning.controller.ts#L50) |
| GET | `/v1/cards/:id` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.read) | [PlanningController.card](../services/planning/src/planning.controller.ts#L53) |
| PATCH | `/v1/cards/:id` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.updateCard](../services/planning/src/planning.controller.ts#L56) |
| POST | `/v1/cards/:id/move` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.move](../services/planning/src/planning.controller.ts#L59) |
| DELETE | `/v1/cards/:id` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.deleteCard](../services/planning/src/planning.controller.ts#L62) |
| GET | `/v1/boards/:id/template-review` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.read) | [PlanningController.review](../services/planning/src/planning.controller.ts#L65) |
| POST | `/v1/boards/:id/template-apply` | StudentScoped; Roles(owner, admin, tutor, student, parent); Permissions(planning.write) | [PlanningController.apply](../services/planning/src/planning.controller.ts#L68) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_planning.sql](../services/planning/migrations/001_planning.sql) | `planning_student_aliases`, `planning_templates`, `planning_boards`, `planning_columns`, `planning_cards`, `planning_instantiations` |

## reporting

Local port: 4010. [Service guide](../services/reporting/README.md).

| Method | Service path | Declared access metadata | Controller |
| --- | --- | --- | --- |
| GET | `/v1/attribution/capabilities` | StudentScoped; Permissions(reporting.read) | [AttributionController.capabilities](../services/reporting/src/attribution.ts#L373) |
| GET | `/v1/attribution/links` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.read) | [AttributionController.list](../services/reporting/src/attribution.ts#L380) |
| POST | `/v1/attribution/links` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.write) | [AttributionController.create](../services/reporting/src/attribution.ts#L391) |
| PATCH | `/v1/attribution/links/:id` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.write) | [AttributionController.update](../services/reporting/src/attribution.ts#L401) |
| POST | `/v1/attribution/links/:id/students` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.write) | [AttributionController.associate](../services/reporting/src/attribution.ts#L413) |
| DELETE | `/v1/attribution/links/:id/students/:studentId` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.write) | [AttributionController.remove](../services/reporting/src/attribution.ts#L427) |
| POST | `/v1/attribution/report` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.read) | [AttributionController.report](../services/reporting/src/attribution.ts#L439) |
| POST | `/v1/attribution/export.csv` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.read) | [AttributionController.csv](../services/reporting/src/attribution.ts#L449) |
| GET | `/v1/public/links/:businessId/:token` | Public | [AttributionRedirectController.redirect](../services/reporting/src/attribution.ts#L472) |
| GET | `/v1/business-dashboard` | Roles(owner, admin, tutor); Permissions(reporting.read) | [BusinessDashboardController.dashboard](../services/reporting/src/business-dashboard.ts#L164) |
| POST | `/v1/summaries` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.read) | [ReportingController.summaries](../services/reporting/src/reporting.controller.ts#L17) |
| GET | `/v1/students/:id/summary` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.read) | [ReportingController.summary](../services/reporting/src/reporting.controller.ts#L28) |
| POST | `/v1/students/:id/reconcile` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.read, reporting.write) | [ReportingController.reconcile](../services/reporting/src/reporting.controller.ts#L43) |
| POST | `/v1/activity` | StudentScoped; Roles(student); Permissions(reporting.write) | [ReportingController.activity](../services/reporting/src/reporting.controller.ts#L58) |
| GET | `/v1/students/:id/activity` | StudentScoped; Roles(owner, admin, tutor); Permissions(reporting.read) | [ReportingController.history](../services/reporting/src/reporting.controller.ts#L68) |

### Owned schema

| Migration | Tables introduced |
| --- | --- |
| [001_reporting.sql](../services/reporting/migrations/001_reporting.sql) | `report_student_aliases`, `report_classes`, `report_assignments`, `report_resources`, `report_invoices`, `report_coverage`, `report_finance_snapshots`, `activity_sessions`, `activity_actor_cursors`, `activity_receipts`, `activity_daily` |
| [002_attribution.sql](../services/reporting/migrations/002_attribution.sql) | `attribution_links`, `attribution_link_students`, `attribution_link_daily` |

## Inventory maintenance

Update controllers, validation schemas, service README and architecture contract in the same change. Regenerate this file and run `node scripts/document-service-inventory.mjs --check`. Internal Better Auth wildcard endpoints, shared health/runtime adapters and dynamically registered endpoints are described in the architecture documents rather than inferred by this generator.
