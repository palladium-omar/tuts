# Business isolation, permissions and customization

> **Contract scope:** The repository implements tenant-scoped databases and row-level security, and services validate signed gateway context. Business profiles and branding are implemented, with seller details projected into billing. Learning files use private persistent disk storage. The role model here includes intended future behavior; student/parent portal relationships, remote object storage, and production paid-entitlement provisioning are not implemented. See the [repository status](../../README.md#what-works-today).

A user can belong to multiple businesses with a different role in each. Roles begin as `owner`, `admin`, `tutor`, `student` and `parent`. Staff roles do not imply access across businesses. A parent/payer and a student are distinct records; one parent may pay for several students. Student/parent portal authorization additionally requires an explicit resource relationship, not merely business membership.

Domain tables carry `business_id`. PostgreSQL row-level policies compare that column with transaction-local `app.business_id`. `withTenant` sets the value inside each transaction, so pooled connections do not retain another tenant's context. Runtime roles are not superusers and have no BYPASSRLS; tenant tables use FORCE ROW LEVEL SECURITY. Constraints and unique keys include business scope where appropriate.

Service-owned outbox/inbox/migration tables are internal infrastructure tables. They are not exposed through business APIs. Their access is bounded by the service database role and private worker process; unlike tenant business tables, the dispatcher must scan multiple tenants.

## Three independent settings

- Entitlements: which paid capabilities a business is allowed to use. This is controlled by platform administration/subscription state, never self-granted by a business update API.
- Configuration: branding, timezone, language, intake fields, cancellation rules and enabled payment methods within purchased capabilities.
- Permissions: which actions a particular membership can perform within that business.

Configuration is schema-validated, versioned data with defaults. Branding uses design tokens; custom fields use a bounded schema. Customer-specific code forks and arbitrary JavaScript execution are not the customization mechanism. Advanced workflows use named, permitted actions and outbound webhooks.

Development provisioning may grant a documented starter feature set to newly created businesses. Production paid entitlement provisioning is separate work. A disabled feature hides its app module and rejects new protected operations in that service. Historical data is preserved and financial reconciliation remains operational.
