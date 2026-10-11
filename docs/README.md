# Tuts documentation

Updated for the **11 October 2026** student portal improvements and the 10 October audit remediation. Release receipts record deployment and validation evidence. Historical review files describe their own release; they are not current deployment guarantees.

## Start here

- [Current system and feature ownership](architecture/system.md): deployment, domains, main workflows, extension rules and account hierarchy.
- [API and schema inventory](service-inventory.md): generated controller routes, their access metadata, source links, and all service migrations. Regenerate rather than hand-edit.
- [Security model](architecture/security.md): trust boundaries, authorization, credentials, uploads and threat controls.
- [Performance model](architecture/performance.md): request paths, batching, caches, database lifecycle and measurable budgets.
- [Student experience review](reviews/2026-10-11-student-experience.md): actual student walkthrough, fixed UX issues and remaining opportunities.
- [Reminder and applicant release review](reviews/2026-10-11-reminders-and-applicants.md): actual provider checks, country rules, test totals and deployment receipts.
- [Audit remediation and release receipt](reviews/2026-10-10-audit-remediation.md): completed changes and remaining operational limits.
- [Current audit and remediation order](reviews/2026-10-10-platform-audit.md): measured evidence, vulnerabilities, limitations and open work.
- [Student reminders and applicant rules](architecture/student-reminders-and-applicant-rules.md): reminder ownership, guided applicant facts, personalized template APIs and researched country limits.
- [Annual application-source review](annual-review.md): every maintained deadline, preparation target, requirement, source and next review trigger.
- [Operations and documentation maintenance](operations.md): checks, releases, recovery and review requirements.

## Feature contracts

| Area | Contract |
| --- | --- |
| Identity, recovery and system mail | [Password recovery](architecture/password-recovery.md), [Platform](../services/platform/README.md) |
| CRM, columns, importing, duplicate merge | [Student identity](architecture/student-workspace.md#phase-1-canonical-students-and-contacts), [Clients](../services/clients/README.md), [Communications](architecture/crm-communications.md) |
| Groups, invitations, tutor tracker, portal | [Student workspace](architecture/student-workspace.md), [Tutor UX](architecture/tutor-workspace-ux.md), [Student UX](architecture/learner-planning-ux.md) |
| Student overview and actionable planning | [Overview contracts and UX](architecture/student-overview.md), [Planning](../services/planning/README.md), [Learning](../services/learning/README.md), [Scheduling](../services/scheduling/README.md) |
| Homework, private files, essays/Google Docs | [Learning](../services/learning/README.md) |
| Calendars, attendance, student bookings | [Scheduling](../services/scheduling/README.md), [Connector protocols](architecture/connectors.md) |
| Monthly arrears invoices, historical work/invoices, dashboard | [Monthly billing](architecture/monthly-billing.md), [History and analytics](architecture/business-history-analytics.md), [Billing](../services/billing/README.md) |
| Payment adapters | [Payments](architecture/payments.md), [Payment service](../services/payments/README.md) |
| Student reminders and direct homework links | [Reminder and applicant architecture](architecture/student-reminders-and-applicant-rules.md), [Notifications](../services/notifications/README.md) |
| Multiple Kanban boards, templates, education-based cycles | [Planning](../services/planning/README.md), [Applicant rules](architecture/student-reminders-and-applicant-rules.md#applicant-api-contract), [Annual source review](annual-review.md), [Earlier planning revision](architecture/student-workspace.md#kanban-interaction-and-application-planning-revision-2026-10-10) |
| Student metrics, activity, attribution and Beacons links | [Reporting](../services/reporting/README.md) |

## Shared contracts and deployment

[Composition](architecture/services.md) · [HTTP](architecture/http.md) · [Events](architecture/events.md) · [Tenancy](architecture/tenancy.md) · [Implementation](architecture/implementation.md) · [Decisions](architecture/decisions.md)

[Cloudflare deployment](cloudflare-deployment.md) · [Domain](cloudflare-domain.md) · [Debugging](production-debugging.md) · [Migration/recovery](data-migration.md) · [Alternative container deployment](deployment.md) · [Agent tooling](agent-setup.md)

## Current delivery limits

System mail is enabled through the verified Resend sender, and production recovery delivery was confirmed from the live form. Real student invitation delivery was not exercised. Live payments and outbound campaigns are disabled. Arbitrary customer API/SMTP/AI egress is unsupported in the Workers adapter. Enterprise administration/licensing and direct Beacons conversion writes are future work. The OpenAPI route is repaired. See the remediation receipt for validation and remaining operational limits.
