# Security model and review boundaries

Current source baseline: `2a44213`; deployment inspected 10 October 2026. This is a description of controls and risks, **not a certification or complete penetration test**. Open findings are in the [platform audit](../reviews/2026-10-10-platform-audit.md).

## Trust boundaries

| Boundary | Existing control | Required review when extending |
| --- | --- | --- |
| Public browser → gateway | TLS, cookie sessions, trusted Origin on mutations, narrow webhook exceptions, overwrite inbound internal identity headers | Public path allowlist, CORS, request limits, cache/referrer headers, authentication rate controls |
| Gateway → Platform | Private binding and dedicated internal secret; live session/membership lookup | Revocation behavior and account/resource policy; no client-supplied grants |
| Gateway → domains | Ed25519 JWT, fixed issuer/audience, short expiry and age checks | Role/action permission plus student/canonical scope; entitlement is not sufficient |
| Service → own PostgreSQL | Restricted service role, parameter SQL, transaction-local tenant setting, ENABLE/FORCE RLS | Every new tenant table/policy/index and cross-tenant insert/read tests |
| Producer → consumers | Private queues, validated versioned envelope, outbox/inbox transactions, revision/dedup handling | Replay/out-of-order effects, poison events, DLQ recovery and retention |
| App → providers | Tenant-bound AES-256-GCM credentials, fixed origins in Workers, no redirects, time/body bounds | SSRF, response validation, financial acceptance uncertainty and secret redaction |
| App → private files | Service-owned R2/disk, scoped metadata lookup and authorized download | MIME/disposition, size/expansion limits, resource grants, malware handling and orphan cleanup |

## Identity and authorization

Better Auth owns password hashing, sessions and recovery verification. Passwords are 8–128 characters without composition rules. Recovery tokens are expiring/single-use, password reset revokes sessions, request responses avoid account enumeration, and database-backed rate limits cover identity endpoints. Recovery mail availability is checked before account lookup and fails closed when disabled or unconfigured. The production verified sender is enabled, and live recovery delivery is confirmed in the release receipt.

`RequestContext` carries actor, business, role, entitlements, request ID, permissions, access scope, student IDs and policy version. Versioned policies must include complete scope fields. Legacy trusted internal contexts remain a compatibility path; external callers cannot mint them. New endpoints must use explicit `@Permissions`, `@StudentScoped` and requested/canonical student checks where appropriate. A student owning a board does not gain staff access to invoice or dashboard endpoints. Hiding a tab is not authorization.

Platform identity/session tables cannot require a selected tenant before login. `identity_business_directory` maps a verified user to discoverable businesses, and Integrations' `integration_tenant_directory` schedules private polling. These two cross-tenant directories deliberately lack tenant RLS. The service outbox/inbox/migrations are also private runtime tables rather than public tenant CRUD. Their absence of RLS is an explicit privileged boundary, not an exemption for new domain tables. Queries must remain service-internal and narrowly scoped; database access itself has broad impact within that service.

The live metadata review found all ten service roles ordinary (`rolsuper=false`, `rolbypassrls=false`). Of 78 tables with a `business_id` column, 76 enforce ENABLE/FORCE RLS; the other two are the documented directories. Policy predicates are defined by migrations and use transaction-local `app.business_id`. This metadata check does not prove every application endpoint is safe; synthetic integration tests add behavioral evidence.

## Secrets and data protection

Signing/private internal secrets belong only to authorized workers. Domains receive verification keys; they cannot sign caller contexts. Provider secrets are encrypted with randomized authenticated ciphertext; tenant ID is authenticated associated data. Stable encryption keys must survive releases and backups. Rotation needs a planned decrypt/re-encrypt process, not replacing a variable and losing old credentials.

Never commit `.env`, `.cloudflare`, `.local`, cookies, reset/invitation URLs, provider secrets, customer workbooks, production SQL dumps or raw logs. Cloudflare secrets and Neon role credentials are operational material. A private repository is not a secret store. Reports should use aggregate counts, filenames and safe support references; do not include customer rows.

Diagnostics whitelist fields and sanitize routes/errors; bodies, account emails, cookies, tokens, SQL parameters and provider response text are excluded. Query-string redaction is enabled; automatic traces are disabled. Retention/sampling limits still apply. Database/transaction/outbox phases and capped browser error categories are now captured. Browser telemetry excludes messages, stacks, URLs, IDs and private input; it is not a complete browser trace.

## Files, external content and abuse

CRM/history uploads cap compressed files at 5 MB; parsers bound rows/cells/archive expansion and do not execute formulas. Learning files allow up to 20 MB with configured type checks. Original historical files are retained inside Billing's PostgreSQL storage; learning bodies use private R2. Uploaded documents are untrusted: Known active PDF/Office content is rejected, including macros/ActiveX/embedded packages and common PDF script/action objects. This is not a full antivirus scan or proof a document is harmless. Download as attachments where appropriate, with nosniff and private/no-store policy; do not render arbitrary HTML inline.

Workers permit only known Cal.com/Calendly origins for calendar fetches and fixed supported mail/WhatsApp endpoints. Arbitrary JSON contact endpoints, SMTP and custom AI calls fail closed in the Workers implementation. Node's flexible egress validates addresses and pins approved DNS results. Provider webhook receipt deduplication and signature/secret validation remain separate from browser sessions.

All API success/error responses are private/no-store. Generated static HTML supplies exact SHA-256 hashes for inline Next hydration scripts; the gateway enforces a CSP allowing same-origin scripts, required booking/Docs frames, no objects, no foreign form actions and no framing. Styles permit inline theme values; images allow HTTPS/data/blob. Regenerate hashes after every static export. CSP is defense in depth, not a substitute for authorization or safe external URLs.

Identity retains its own rate controls. Expensive upload/import/sync/reconcile operations use durable per-minute budgets: 20 per actor and 60 per tenant; Reporting allows 120 per actor and 300 per tenant. Unscoped public ingestion has a service-wide 120/minute ceiling. Only verified context supplies tenant/actor identity; arbitrary headers are not trusted. Rejections return 429 and Retry-After: 60. Bridge request/response bounds limit buffering. These are rate budgets, not active-concurrency leases; workload queues remain a scale extension.

## Financial integrity and analytics

Use exact minor units and separate currencies. Financial writes have tenant/operation-scoped idempotency; provider attempts snapshot expected amount/currency/customer connection. Imported paid history is an assertion; simulated payments never become confirmed revenue. Preserve issued invoice snapshots through student merges. Live payment adapters are not currently enabled.

Analytics expose source coverage and estimates. Imported source names are not canonical identity; unreviewed or ambiguous identity yields unknown person metrics. Explicit reviewed work-row links are owned by Billing and verified against Clients. Inactivity is not confirmed churn and browser activity is an estimate. Do not use these metrics as reliable individual decisions without validated identity/coverage.

## Required change checks

For a new route/table/connector, cover missing/forged/expired context, wrong tenant, wrong student, absent capability, canonical alias scope, over-limit input, duplicate/reordered events, unavailable providers and idempotent uncertain retries. Run affected tests with ordinary database roles; skipped integration tests are not isolation proof. Maintain source links and update the route inventory. Backups/restoration, account protection, secret rotation and customer-data deletion are operational obligations beyond unit tests.

## Retention and recovery

Published outbox payloads expire after 30 days, in bounded 1,000-row maintenance batches. Pending events and inbox deduplication identities are retained. Expired per-minute budget windows are operational state and may be pruned independently. Financial history, preserved import sources, student work and activity are never deleted by this housekeeping; business deletion/export policies require a separate reviewed workflow. Queue/dead-letter retention is 24 hours; transport R2 pointers last seven days. Operators must resolve failures promptly, preserving event IDs on replay.

[Recovery tooling](../../scripts/RECOVERY.md) validates all ten services, exact archived migrations/catalogs and lossless row hashes. Local restoration is restricted to new loopback databases and does not start providers or events. Encrypted backups include private deployment configuration/keys and both private R2 buckets; the decryption key is separate. Check the remediation receipt for actual hosted backup/restore evidence. Tooling alone does not establish an automatic backup schedule, Neon PITR coverage or a recovery guarantee.
