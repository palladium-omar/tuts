# Operations and documentation maintenance

Use the [current architecture](architecture/system.md), [deployment guide](cloudflare-deployment.md), [security model](architecture/security.md), and [audit](reviews/2026-10-10-platform-audit.md). This is the current Cloudflare/Neon target; container/GCP instructions are an alternative, not evidence of hosted backups.

## Change checklist

Every feature or cross-cutting change should include:

1. Owning service and authoritative data; wire/API/event compatibility.
2. Capability, tenant/student scope and invitation/merge effects.
3. New migration/policy/index, bindings/secrets, limits and deployment sequence.
4. Loading/query/cache behavior, invalidation and unavailable-service fallback.
5. Service README, architecture contract and generated route/schema inventory updates.
6. Relevant unit, ordinary-role integration, runtime and UI checks; explicitly name skips.
7. Verified release identifiers, public/authenticated checks and rollback constraints.

Enterprise role/hierarchy work needs a separate design before any cross-tenant scope expansion. Shared service-kit changes affect all ten domain deployables, not just the screen that triggered the change.

## Repository checks

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm check:boundaries
node scripts/document-service-inventory.mjs --check
pnpm -r --no-bail --if-present test
node --test infra/cloudflare/deployment.test.mjs
node scripts/test-workbook-runtime.mjs
pnpm audit --prod
```

After controller/migration edits, run `node scripts/document-service-inventory.mjs` and commit the inventory. CI runs build, typecheck, boundaries, inventory, complete package tests and workbook runtime. PostgreSQL tests require their `<SERVICE>_TEST_DATABASE_URL`; Platform authentication tests additionally need test-only Better Auth/internal secrets. Without these settings, CI's integration tests skip. A required isolated database job is still open work.

Use ordinary local roles and isolated synthetic data. Never point test database variables at hosted production. Tests may create and remove fixtures. Database-backed evidence must include role restrictions and skip counts; a superuser test cannot prove RLS.

## Release discipline

Keep the default branch aligned with the reviewed source actually deployed. A pushed feature branch is not evidence the default README is current. GitHub workflow success is also distinct from deployment success: current CI does not automatically deploy the application.

Before a runtime release, inspect the working tree and current service deployments; preserve unrelated files. Commit/review changes and build a clean release. Apply service-owned migrations outside Workers, preserving stable signing/encryption keys. Deploy affected services in dependency-compatible order, then gateway/assets if needed. A shared runtime change may require all domain Workers.

Verify current deployed Worker versions, selected migrations, domain/TLS, canonical redirect, HTML/assets, unauthenticated denial and relevant authenticated customer flow. For sender changes, verify actual inbox delivery; for payments, distinguish test assertions from real collections. Keep detailed credentials, customer records and raw receipts in ignored private operational storage.

Record release commit, deployable versions, migration results, verification date/limits and rollback steps. Docs-only changes and test/CI changes do not require redeploying unchanged application code. This audit leaves the deployed runtime at application `2a44213`.

## Incidents and performance

Start from the support Reference UUID and approximate time; correlate gateway/domain logs as described in [production debugging](production-debugging.md). Report route/status/durations and safe error classifications. Never paste tokens, URLs with secrets, customer file contents, raw provider errors or cookies into GitHub.

Use Server-Timing to separate identity and upstream work. Current logs lack detailed connection/query/outbox phase instrumentation and comprehensive browser errors. Record warm/cold conditions and sample sizes; do not infer a database outage from an anonymous HTTP timing outlier.

If an optional domain fails, preserve the usable screen and prior scoped data with an explicit stale/unavailable state. Authentication/membership failures must fail closed. Do not turn missing financial/attendance history into zeros.

## Recovery, keys and retention

Preserve database snapshots, private learning objects and stable signing/encryption configuration together. Historical migration snapshots are not an automatic backup schedule. The original `migrate-local-data.mjs` uses an eight-service table allowlist and fails closed on current schemas; it cannot be the current complete restore tool (audit A-05). Audit current Neon retention, independent backup storage and R2 coverage; restore into isolation before claiming recovery objectives. No current production restoration exercise was performed in this audit.

Outbox/inbox cleanup, expired previews, activity retention and archived customer-source deletion need documented policies. Never prune pending events or dedup state arbitrarily. Transport R2 payloads expire after seven days, so stalled queues/outboxes require timely investigation and recovery from producer state.

Roll back code only when migrations remain compatible. For incompatible schema changes, restore a consistent database/file/key set through a reviewed recovery procedure. Do not delete database volumes, rotate encryption keys blindly, force-push history or remove active feature branches as cleanup.
