# Moving existing Tuts data to Cloudflare and Neon

`scripts/cloudflare.mjs migrate` creates databases, roles and schema. It does **not** copy existing accounts, business records or uploads. A new hosting environment must include an explicit data transfer before it replaces an existing installation. Ordinary code deployments against the existing hosted databases do not require another import.

## Preserve the source

Pause local application writers while leaving PostgreSQL and RabbitMQ running. Back up all eight databases with `pg_dump --format=custom`, the private upload directory, and the original encryption settings. Store these only in an ignored private recovery directory with directory mode 0700 and file mode 0600. Preserve the hosted deployment settings and encryption keys separately. Do not delete a database or Docker volume.

Check that source outboxes and RabbitMQ delivery/retry/dead-letter queues are drained. A pending event needs reconciliation with consumer projections before migration; this tool refuses pending source outbox rows.

## Close the hosted app during transfer

The deployed gateway must include `TUTS_MAINTENANCE` support. Then run:

```sh
node scripts/cloudflare-maintenance.mjs pause
node scripts/cloudflare-maintenance.mjs status
```

This snapshots the existing gateway cron and six consumer-queue settings, enables a 503 maintenance response, disables cron and pauses queue delivery. It does not cancel requests already running. Allow them to drain before taking the target inventory. The private restoration state is `.cloudflare/recovery/maintenance-state.json`; retain it until recovery is complete. No provider messages or payment operations should be initiated as part of migration.

## Snapshot, audit and import

Run from the repository root. The local source is the eight service databases on `127.0.0.1:5434`, using `.env`. The target uses the eight ordinary service roles in `.cloudflare/secrets.json`. The command defaults to a read-only audit:

```sh
node scripts/migrate-local-data.mjs audit
node scripts/migrate-local-data.mjs snapshot
```

The snapshot prints its private directory. If the source contains rows belonging to tenant IDs with no Platform business, the default command stops. After examining ownership, `snapshot --archive-orphan-tenants` explicitly retains those rows in the private archive while excluding them from the active import. It never deletes source rows. Do not infer that an unowned row is a test fixture without evidence.

Using the exact snapshot directory printed above:

```sh
node scripts/migrate-local-data.mjs audit --snapshot .cloudflare/recovery/<snapshot>
node scripts/migrate-local-data.mjs apply --snapshot .cloudflare/recovery/<snapshot> --writers-frozen
node scripts/migrate-local-data.mjs verify --snapshot .cloudflare/recovery/<snapshot>
```

The tool checks schema and migration parity, verified TLS, service-role isolation, existing target conflicts and unchanged target keys. PostgreSQL 18's separate NOT NULL catalog entries are normalized; column nullability remains checked. It preserves account password hashes, IDs, timestamps, financial values, inbox deduplication and published event history. Connector credentials are decrypted and reencrypted in memory for the hosted keys. Old browser sessions and temporary verification tokens stay in the archive; users sign in again.

Each service imports in its own transaction through its own role with tenant RLS enforced. Platform identities become available last. Existing target rows must be empty or match the snapshot exactly; the tool never overwrites conflicts. Per-table counts and row digests are checked before commit and again across all eight databases. Ordinary RLS roles cannot enumerate a preexisting orphan tenant without discovery metadata, so target provenance must be established separately.

Eight service commits are not one distributed transaction. If interrupted, keep maintenance enabled and rerun **the same snapshot**. Completely matching services are skipped. A conflict requires investigation; do not erase new hosted data to make the check pass. Preserve the original dumps for separate restoration if necessary.

## Restore uploads and reopen

Copy each referenced stored file from `.local/uploads/<business_id>/<storage_key>` into the private `tuts-uploads` R2 bucket using that same object key and MIME type. Check for existing objects before writing and compare downloaded bytes or a cryptographic digest afterward. Metadata without its object is an incomplete migration. Keep bucket public access disabled.

Review imported connection and campaign states, unfinished external operations and provider restrictions before restoring background work. Outbound messaging remains disabled by the production configuration; sandbox payment connections do not become live providers through migration. Confirm all eight database copies and all referenced uploaded files before reopening:

```sh
node scripts/cloudflare-maintenance.mjs resume
node scripts/cloudflare-maintenance.mjs status
```

Resume restores saved cron/queue settings and clears the maintenance flag last. Check HTTPS and the public API afterward. Database equality and file checks do not by themselves prove an interactive login or every connected provider workflow.

## October 4, 2026 recovery evidence

The original local database volume survived the initial hosting cutover. All eight source databases, upload files and encryption settings were backed up before transfer. Source outboxes and RabbitMQ queues were drained; the target was empty within all discovered tenant scopes, with no hosted identities. Schema comparison and service-role isolation checks passed.

The restored records include one account, four owned workspaces, 20 CRM records, 265 external and three local session records, two assignments, one stored resource and three invoices, plus their related projections, configuration, credentials and event history. Every active table matched its expected snapshot count and row digest after import. The referenced resource was uploaded to private R2 and its downloaded bytes matched the 97-byte original.

Fifteen historical rows referenced tenant IDs without any Platform business. Those rows remain in the private source archives and were excluded from the active copy; the original local databases were not changed. The old browser session also remains archived. Account password hashes were copied unchanged. No outbound messages or payment operations were initiated; the saved campaign is a draft, there are no pending payment attempts, and no automatic billing settings were configured.

Hosted interactive sign-in and connected-provider behavior still require separate verification. Migration equality and storage read-back are the verified scope of this recovery.
