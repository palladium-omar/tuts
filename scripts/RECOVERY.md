# Current ten-service recovery

The October 4 eight-service cutover is historical. `migrate-local-data.mjs`
refuses operations; do not remove its schema checks to restore a newer system.
The current tools have no production restore command. Every restore target must
be a **new local** database named `restore_NAME_SERVICE`; existing databases and
remote PostgreSQL hosts are refused before creation. No application, broker,
mail or payment provider starts during the restore.

## Scope and verified evidence

`snapshot-hosted-data.mjs` captures all ten database catalogs, exact applied
migration SQL, raw PostgreSQL JSON rows, RLS/trigger metadata and sequence state.
It requires manually frozen ingress, scheduled jobs, queue delivery and provider
webhooks, with in-flight work settled. Temporary owner visibility and locks occur
only in rolled-back transactions. Partial service inventories fail closed.

`encrypted-backup.mjs create` adds both private R2 buckets, deployment settings,
the complete deployment secrets/key JSON and generated Worker configurations to
an AES-256-GCM encrypted local copy **outside the repository and Cloudflare**.
The independent 32-byte backup key is never included in the bundle. Escrow it
separately; losing it makes the bundle unrecoverable. Do not paste keys, URLs or
object metadata in chat or logs.

The backup reads R2 with existing project Wrangler authorization and the
[documented paginated R2 objects API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/).
It rechecks the object inventory after capture, checks source hashes, rejects
changed etags/sizes and verifies that every stored Learning resource has a
matching object. Default limits are 32 MiB per R2 object, 4 GiB total payload,
100,000 entries and a two-hour coordinated freeze window. Limits fail closed;
explicitly review larger archives before raising the total budget. No remote
objects are written or deleted.

Authentication completes before plaintext is extracted into a new private
local directory. Corrupted/wrong-key bundles leave no extracted restore files.
Files then receive hash/count checks. Raw JSON values go directly into
`jsonb_populate_record`; large integers never pass through JavaScript numeric
serialization. Exact archived migrations recreate schemas. Foreign keys are
loaded in dependency order and temporarily removed for cycles, then reinstalled
and validated in the same transaction. Triggers and FORCE RLS return to their
original states. Sequences receive exact last-value/is-called verification.

The synthetic local PostgreSQL test recreates and restores all ten current
service schemas with cyclic FK rows, large integer/numeric values, nondefault
sequences, pending outbox rows and inbox tombstones. Its receipt records actual
local restore milliseconds. That small fixture does **not** establish hosted
recovery time, production throughput or a disaster recovery guarantee.

## One-time private handoff commands

Run from this checkout. Coordinate a maintenance freeze with the root operator
before the snapshot; these commands do not freeze or restart services themselves.
A successful R2 inventory is read-only and prints only counts/bytes:

```sh
node scripts/encrypted-backup.mjs inventory
```

Create a private destination and independent encryption key once. This example
stores the backup on the local machine, outside the cloud provider; put an
additional verified copy and the separately escrowed key on independent storage.
The local PostgreSQL admin URL stays in a protected file rather than arguments.

```sh
export TUTS_BACKUP_DIR="$HOME/Private Backups/Tuts"
mkdir -p "$TUTS_BACKUP_DIR"
chmod 700 "$TUTS_BACKUP_DIR"
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
const directory = process.env.TUTS_BACKUP_DIR;
try { await writeFile(join(directory, 'backup.key'), randomBytes(32), { mode: 0o600, flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const env = parseEnv(await readFile('.env', 'utf8'));
const url = new URL('postgresql://postgres@127.0.0.1:5434/postgres');
url.password = env.POSTGRES_PASSWORD;
await writeFile(join(directory, 'local-admin.url'), url.toString(), { mode: 0o600, flag: 'wx' });
JS
```

After **all writers are actually paused and in-flight work has settled**, record
that time, take the database snapshot, then select the directory printed by the
snapshot tool. Keep writers paused through successful bundle verification.

```sh
export TUTS_FREEZE_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/snapshot-hosted-data.mjs --writers-frozen
export TUTS_SNAPSHOT=".cloudflare/recovery/hosted-REPLACE_WITH_PRINTED_TIMESTAMP"
export TUTS_BACKUP_FILE="$TUTS_BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ).tuts-backup"
node scripts/encrypted-backup.mjs create \
  --snapshot "$TUTS_SNAPSHOT" --key-file "$TUTS_BACKUP_DIR/backup.key" \
  --output "$TUTS_BACKUP_FILE" --writers-frozen --freeze-start "$TUTS_FREEZE_START"
node scripts/encrypted-backup.mjs verify \
  --backup "$TUTS_BACKUP_FILE" --key-file "$TUTS_BACKUP_DIR/backup.key"
```

The ciphertext and `.receipt.json` are the off-Cloudflare copy. Preserve the
private database source archive until an independently stored copy and recovery
exercise are verified. A local disk copy is not proof of geographic redundancy,
offline immutability or a scheduled backup policy.

Use **new** paths and an explicit unique restore prefix for a recovery exercise:

```sh
export TUTS_EXTRACTED="$TUTS_BACKUP_DIR/isolated-extract-$(date -u +%Y%m%dT%H%M%SZ)"
export TUTS_LOCAL_STORAGE="$TUTS_BACKUP_DIR/isolated-storage-$(date -u +%Y%m%dT%H%M%SZ)"
node scripts/encrypted-backup.mjs extract \
  --backup "$TUTS_BACKUP_FILE" --key-file "$TUTS_BACKUP_DIR/backup.key" \
  --target "$TUTS_EXTRACTED"
node scripts/restore-hosted-snapshot.mjs \
  --snapshot "$TUTS_EXTRACTED/snapshot" \
  --admin-url-file "$TUTS_BACKUP_DIR/local-admin.url" \
  --prefix "restore_$(date -u +%Y%m%d%H%M%S)"
node scripts/encrypted-backup.mjs materialize-local \
  --extracted "$TUTS_EXTRACTED" --target "$TUTS_LOCAL_STORAGE"
```

Review the private database receipt and `LOCAL_STORAGE_VERIFIED.json` before
planning application recovery. Local materialization accepts only canonical
upload/event-key layouts, preserves bytes and never uploads to R2. Restored
configuration remains evidence; do not copy live credentials into a runnable
local application or start delivery. Database objects are locally owned by the
restore administrator. Production role/grant recreation, infrastructure names,
provider credentials, key rotation and mail/payment activation require a
separate reviewed recovery plan.

## Retention and resource policy

| Class | Current treatment |
| --- | --- |
| Pending/partially published outbox | Never pruned; retained as authoritative publication source |
| Published outbox | Runtime prunes payloads older than 30 days in batches of at most 1,000 |
| Inbox IDs | Permanent replay tombstones; pruning could repeat side effects |
| R2 event payloads | Existing seven-day lifecycle; DLQ/replay recovery beyond that window must rebuild reviewed transport from the retained canonical event |
| Learning uploads | Backed up with reference/size coverage; no automatic deletion introduced |
| Billing sources/financial history/activity receipts | No new purge; explicit business/legal policy and source export/deletion workflow remain to be decided |
| Request budget counters | Atomic per-minute actor/tenant rates; expired buckets pruned after one day |
| Encrypted backup copies | Review expiration after 30 days while retaining at least seven complete copies; incomplete/unverified files are excluded |

The retention report is deliberately nondestructive:

```sh
node scripts/encrypted-backup.mjs retention-report --directory "$TUTS_BACKUP_DIR"
```

It uses completion receipts/lengths as an inventory hint, **not** a substitute for
cryptographic verification. Verify each independent copy before any reviewed
expiration. No tool here deletes customer records, R2 objects or backups.

## RPO/RTO and remaining work

**Current RPO is unbounded between manually verified captures.** There is no
verified recurring hosted snapshot schedule. The recoverable database/file point
is the coordinated freeze used by a successful authenticated bundle; receipt
timestamps describe that capture only. No claim of a 24-hour RPO is made.

**Hosted RTO is unmeasured.** The local synthetic database receipt measures
creation, data load and verification for ten small schemas. It excludes incident
response, infrastructure provisioning, production-sized data, role/grant/key
recovery, restoring R2 to new cloud buckets, application restart and user checks.
A target RTO must be chosen and tested against a full isolated hosted exercise.

Queue/DLQ contents are not exported by this bundle. Settle or inventory in-flight
messages before capture; archived outbox/inbox entries allow reviewed recovery,
not automatic replay. Inbox tombstones must accompany any reviewed replay to
prevent duplicate business effects. Neon plan/restore-point retention, independently
stored encrypted copies, key escrow, full-volume tests and automated scheduler
ownership/monitoring remain operational work. The tool does not claim completion
of those tasks merely because local tests pass.

## Validation

```sh
pnpm --filter @palladium/service-kit build
RECOVERY_TEST_LOCAL=1 node --test scripts/tests/recovery.test.mjs
node --test scripts/tests/encrypted-backup.test.mjs
```

The database suite requires the existing local PostgreSQL administrator defined
by `.env`, creates only unique synthetic databases, and cleans up its own targets.
It fails when local execution is not explicitly enabled rather than silently
skipping recovery coverage. The encryption suite uses synthetic private config
and a fake read-only R2 client; it never makes provider writes.
