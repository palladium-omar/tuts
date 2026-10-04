/**
 * One-time, private recovery from local PostgreSQL to eight isolated hosted DBs.
 * Default: read-only audit. No migrations, deletes, external provider calls, or R2 writes.
 *
 * node scripts/migrate-local-data.mjs [audit|snapshot]
 * node scripts/migrate-local-data.mjs snapshot --archive-orphan-tenants
 * node scripts/migrate-local-data.mjs audit --snapshot .cloudflare/recovery/<stamp>
 * node scripts/migrate-local-data.mjs apply --snapshot <path> --writers-frozen
 * node scripts/migrate-local-data.mjs verify --snapshot <path>
 *
 * Before snapshot/apply: freeze local writers, hosted ingress, cron, queue consumers,
 * and provider webhooks; back up the eight DBs and private uploads separately.
 * Each hosted service commits independently. After interruption, rerun the same
 * snapshot: a service is skipped only if ALL of its active rows match exactly.
 * Snapshot files contain real account hashes and encrypted credentials. Keep private.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, readdir, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const recoveryRoot = join(root, '.cloudflare', 'recovery');
const order = {
  clients: ['clients', 'client_payers', 'client_external_sources', 'client_fields', 'client_import_requests', 'disconnected_client_sources'],
  scheduling: ['sessions', 'external_sessions', 'class_annotations', 'class_ledger', 'disconnected_session_sources'],
  learning: ['resources', 'assignments', 'assignment_resources'],
  billing: ['business_seller_profiles', 'invoices', 'payment_allocations', 'billing_idempotency', 'billing_settings', 'student_rates', 'billing_classes', 'billed_classes', 'monthly_reconciliations'],
  payments: ['payment_connections', 'invoice_snapshots', 'payment_attempts', 'provider_events', 'stripe_checkout_sessions', 'payments_idempotency'],
  integrations: ['integration_tenant_directory', 'integration_connections'],
  notifications: ['notifications', 'communication_connections', 'communication_campaigns', 'communication_recipients', 'communication_consent'],
  platform: ['user', 'account', 'businesses', 'memberships', 'identity_business_directory', 'session', 'verification'],
};
const services = Object.keys(order); // Platform identities become visible last.
const shared = ['service_inbox', 'service_outbox'];
const archivedOnly = new Set(['session', 'verification']);
const credentials = {
  payment_connections: ['credentials_ciphertext', 'PAYMENT_ENCRYPTION_KEY', 'payment'],
  integration_connections: ['credentials_encrypted', 'INTEGRATIONS_ENCRYPTION_KEY', 'tenant'],
  communication_connections: ['credentials_encrypted', 'COMMUNICATIONS_ENCRYPTION_KEY', 'tenant'],
};
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const tableDigest = rows => digest(JSON.stringify([...rows].sort()));
const qi = name => {
  if (!/^[a-z][a-z_\d]*$/.test(name)) throw new Error('Unsafe SQL identifier');
  return `"${name}"`;
};
const tableName = name => `public.${qi(name)}`;
const safeError = message => Object.assign(new Error(message), { recoverySafe: true });
const fail = message => { throw safeError(message); };
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'audit';
let snapshotPath, frozen = false, archiveOrphanTenants = false;
while (args.length) {
  const arg = args.shift();
  if (arg === '--snapshot' && args[0] && !args[0].startsWith('--')) snapshotPath = resolve(root, args.shift());
  else if (arg === '--writers-frozen') frozen = true;
  else if (arg === '--archive-orphan-tenants') archiveOrphanTenants = true;
  else fail('Usage: [audit|snapshot|apply|verify] [--snapshot PATH] [--writers-frozen] [--archive-orphan-tenants]');
}
if (!['audit', 'snapshot', 'apply', 'verify'].includes(command)) fail('Unknown recovery command');
if (['apply', 'verify'].includes(command) && !snapshotPath) fail('This command requires --snapshot PATH');
if (command === 'snapshot' && snapshotPath) fail('Snapshot always creates a new private recovery directory');
if (archiveOrphanTenants && command !== 'snapshot') fail('--archive-orphan-tenants is only accepted for a new snapshot');
if (command === 'apply' && !frozen) fail('Apply requires --writers-frozen after ingress, cron, consumers and local writers are frozen');

async function privateJson(path, value, exclusive = false) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  await chmod(path, 0o600);
}
function decodeKey(value, format) {
  if (typeof value !== 'string') fail('Required connector encryption key is missing');
  const bytes = Buffer.from(value, format === 'payment' ? 'base64' : /^[a-f\d]{64}$/i.test(value) ? 'hex' : 'base64');
  if (bytes.length !== 32 || (format === 'payment' && bytes.toString('base64') !== value)) fail('Connector encryption key has an invalid encoding');
  return bytes;
}
function rewrap(json, table, local, hosted) {
  const config = credentials[table];
  if (!config) return json;
  const [field, keyName, format] = config;
  const row = JSON.parse(json), encrypted = row[field];
  if (encrypted === null) return json;
  if (typeof encrypted !== 'string' || !uuid.test(row.business_id)) fail(`Invalid encrypted credential record in ${table}`);
  const oldKey = decodeKey(local[keyName], format), newKey = decodeKey(hosted[keyName], format);
  let parts = encrypted.split('.'), encoding = 'base64url', aad = true;
  if (format === 'payment') {
    const version = parts.shift();
    if (!['v1', 'v2'].includes(version)) fail('Unknown payment credential ciphertext version');
    aad = version === 'v2';
    encoding = 'base64';
  }
  if (parts.length !== 3) fail(`Invalid ciphertext format in ${table}`);
  const [iv, tag, data] = parts.map(value => Buffer.from(value, encoding));
  if (iv.length !== 12 || tag.length !== 16) fail(`Invalid ciphertext dimensions in ${table}`);
  const decipher = createDecipheriv('aes-256-gcm', oldKey, iv);
  if (aad) decipher.setAAD(Buffer.from(row.business_id));
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(data), decipher.final()]);
  try {
    const value = JSON.parse(clear.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid encrypted payload in ${table}`);
    const newIv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', newKey, newIv);
    cipher.setAAD(Buffer.from(row.business_id));
    const result = Buffer.concat([cipher.update(clear), cipher.final()]);
    const encoded = [newIv, cipher.getAuthTag(), result].map(value => value.toString(encoding));
    if (format === 'payment') encoded.unshift('v2');
    const replacement = `${JSON.stringify(field)}: ${JSON.stringify(encrypted)}`;
    if (!json.includes(replacement)) fail('Credential field could not be located without altering numeric precision');
    return json.replace(replacement, `${JSON.stringify(field)}: ${JSON.stringify(encoded.join('.'))}`);
  } finally { clear.fill(0); }
}

// Metadata excludes owners, database-specific OIDs and extension-owned functions.
// Exact definitions deliberately fail closed on schema drift.
async function metadata(client) {
  const queries = {
    tables: `SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`,
    columns: `SELECT c.relname AS table_name,a.attname AS name,a.attnum AS position,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`,
    // PostgreSQL 18 catalogs NOT NULL separately; column attnotnull compares it on both 17/18.
    constraints: `SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,pg_get_constraintdef(k.oid,true) AS definition,k.convalidated AS validated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND k.contype<>'n'`,
    indexes: `SELECT tablename AS table_name,indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname='public'`,
    policies: `SELECT tablename AS table_name,policyname AS name,permissive,roles::text,cmd,qual,with_check FROM pg_policies WHERE schemaname='public'`,
    triggers: `SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`,
    functions: `SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`,
    extensions: `SELECT extname AS name FROM pg_extension`,
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) {
    result[name] = (await client.query(`SELECT to_jsonb(m)::text AS json FROM (${sql}) m`)).rows.map(row => row.json).sort();
  }
  return result;
}
async function migrationFiles(service) {
  const directory = join(root, 'services', service, 'migrations');
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(files.map(async name => ({ name, sha256: digest(await readFile(join(directory, name))) })));
}
async function sessionSettings(client, readOnly = true) {
  await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ${readOnly ? ' READ ONLY' : ''}`);
  await client.query("SET LOCAL timezone='UTC'");
  await client.query('SET LOCAL extra_float_digits=3');
  await client.query("SET LOCAL lock_timeout='15s'");
  await client.query("SET LOCAL statement_timeout='120s'");
}
async function localClient(service, local) {
  if (!local.POSTGRES_PASSWORD) fail('Local PostgreSQL admin password is missing from .env');
  const client = new pg.Client({ host: '127.0.0.1', port: 5434, database: service, user: 'postgres', password: local.POSTGRES_PASSWORD, connectionTimeoutMillis: 10000 });
  await client.connect();
  return client;
}
async function hostedClient(service, secrets) {
  const raw = secrets.databaseUrls?.[service];
  if (typeof raw !== 'string') fail(`Missing hosted database URL for ${service}`);
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) fail('Invalid hosted database URL');
  url.searchParams.set('sslmode', 'verify-full');
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000 });
  Object.assign(client.connectionParameters.ssl, { rejectUnauthorized: true, checkServerIdentity });
  await client.connect();
  try {
    const stream = client.connection.stream;
    if (!stream.encrypted || !stream.authorized || stream.authorizationError || checkServerIdentity(client.connectionParameters.host, stream.getPeerCertificate())) fail('Hosted database requires verified TLS');
    const row = (await client.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!row?.rolcanlogin || ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication'].some(key => row[key])) fail(`Unsafe hosted role for ${service}`);
    if ((await client.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rowCount) fail(`Hosted role has inherited memberships for ${service}`);
    for (const other of services.filter(name => name !== service)) {
      const otherDb = decodeURIComponent(new URL(secrets.databaseUrls[other]).pathname.slice(1));
      if ((await client.query("SELECT has_database_privilege(current_user,$1,'CONNECT') AS allowed", [otherDb])).rows[0].allowed) fail(`Hosted ${service} role can access another service database`);
    }
    return client;
  } catch (error) { await client.end(); throw error; }
}
function targetIdentity(secrets) {
  const identities = services.map(service => {
    const url = new URL(secrets.databaseUrls?.[service] ?? '');
    return { service, host: url.hostname, database: decodeURIComponent(url.pathname.slice(1)), role: decodeURIComponent(url.username) };
  });
  if (new Set(identities.map(row => `${row.host}/${row.database}`)).size !== 8 || new Set(identities.map(row => `${row.host}/${row.role}`)).size !== 8) fail('Exactly eight distinct hosted service databases and roles are required');
  return identities;
}
async function readRows(client, table, tenants, schema, sourceAdmin = false) {
  const tableSchema = schema.tables.map(JSON.parse).find(row => row.name === table);
  if (!tableSchema) fail(`Missing table ${table}`);
  if (sourceAdmin || !tableSchema.rls) {
    return (await client.query(`SELECT to_jsonb(t)::text AS json FROM ${tableName(table)} t`)).rows.map(row => row.json).sort();
  }
  const rows = [];
  for (const businessId of tenants) {
    await client.query("SELECT set_config('app.business_id',$1,true)", [businessId]);
    rows.push(...(await client.query(`SELECT to_jsonb(t)::text AS json FROM ${tableName(table)} t`)).rows.map(row => row.json));
  }
  await client.query("SELECT set_config('app.business_id','',true)");
  return rows.sort();
}
async function capture(local, secrets) {
  const snapshot = { version: 1, createdAt: new Date().toISOString(), targets: targetIdentity(secrets), services: {}, businessIds: [], keyFingerprints: {}, archiveOrphanTenants, orphanTenantRows: [] };
  // Global discovery first, independent of export/import service order.
  const platform = await localClient('platform', local);
  try {
    await sessionSettings(platform);
    snapshot.businessIds = (await platform.query('SELECT business_id::text FROM businesses ORDER BY business_id')).rows.map(row => row.business_id);
    await platform.query('ROLLBACK');
  } finally { await platform.end(); }
  for (const service of services) {
    const client = await localClient(service, local);
    try {
      await sessionSettings(client);
      const schema = await metadata(client), tables = [...order[service], ...shared];
      const actual = schema.tables.map(JSON.parse).map(row => row.name).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...tables, 'service_migrations'].sort())) fail(`Unexpected local table set in ${service}`);
      const migrations = (await client.query('SELECT name FROM service_migrations ORDER BY name')).rows.map(row => row.name);
      const files = await migrationFiles(service);
      if (JSON.stringify(migrations) !== JSON.stringify(files.map(row => row.name))) fail(`Local migrations differ from this checkout for ${service}`);
      const data = { schema, migrations, migrationFiles: files, tables: {}, pendingOutbox: 0 };
      for (const table of tables) {
        const source = await readRows(client, table, snapshot.businessIds, schema, true);
        const active = [], orphans = new Map();
        for (const json of source) {
          const row = JSON.parse(json), businessId = row.business_id ?? (table === 'service_outbox' ? row.event?.businessId : null);
          if (businessId && !snapshot.businessIds.includes(businessId)) {
            if (!archiveOrphanTenants) fail(`Unknown source tenant in ${service}.${table}; audit ownership before explicitly archiving orphan tenants`);
            orphans.set(businessId, (orphans.get(businessId) ?? 0) + 1);
          } else active.push(json);
        }
        for (const [businessId, count] of orphans) snapshot.orphanTenantRows.push({ service, table, businessId, count });
        const expected = archivedOnly.has(table) ? [] : active.map(json => rewrap(json, table, local, secrets));
        data.tables[table] = { source, expected, sourceCount: source.length, expectedCount: expected.length, sourceSha256: tableDigest(source), expectedSha256: tableDigest(expected) };
        if (credentials[table] && expected.some(json => JSON.parse(json)[credentials[table][0]] !== null)) {
          const [, key, format] = credentials[table];
          snapshot.keyFingerprints[key] = digest(decodeKey(secrets[key], format));
        }
      }
      data.pendingOutbox = data.tables.service_outbox.source.filter(json => JSON.parse(json).published_at === null).length;
      snapshot.services[service] = data;
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  }
  return snapshot;
}
async function saveSnapshot(snapshot) {
  await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
  await chmod(recoveryRoot, 0o700);
  const directory = join(recoveryRoot, `${snapshot.createdAt.replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 });
  const { services: data, ...manifest } = snapshot;
  manifest.files = {};
  for (const service of services) {
    const path = join(directory, `${service}.json`);
    await privateJson(path, data[service], true);
    manifest.files[service] = digest(await readFile(path));
  }
  await privateJson(join(directory, 'manifest.json'), manifest, true);
  return directory;
}
async function loadSnapshot(directory) {
  const base = await realpath(recoveryRoot), actual = await realpath(directory);
  if (!actual.startsWith(`${base}${sep}`)) fail('Snapshot must be inside this checkout .cloudflare/recovery directory');
  const manifest = JSON.parse(await readFile(join(actual, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || Object.keys(manifest.files ?? {}).sort().join(',') !== [...services].sort().join(',')) fail('Invalid recovery manifest');
  const result = { ...manifest, services: {} };
  for (const service of services) {
    const raw = await readFile(join(actual, `${service}.json`));
    if (digest(raw) !== manifest.files[service]) fail(`Snapshot integrity check failed for ${service}`);
    const data = JSON.parse(raw.toString('utf8'));
    if (Object.keys(data.tables).sort().join(',') !== [...order[service], ...shared].sort().join(',')) fail(`Snapshot table set invalid for ${service}`);
    for (const [table, rows] of Object.entries(data.tables)) {
      if (rows.sourceCount !== rows.source.length || rows.expectedCount !== rows.expected.length || tableDigest(rows.source) !== rows.sourceSha256 || tableDigest(rows.expected) !== rows.expectedSha256) fail(`Snapshot row integrity failed for ${service}.${table}`);
      if (archivedOnly.has(table) && rows.expected.length) fail(`Archived authentication rows cannot be imported from ${service}.${table}`);
      for (const json of rows.expected) {
        const row = JSON.parse(json), businessId = row.business_id ?? (table === 'service_outbox' ? row.event?.businessId : null);
        if (businessId && !manifest.businessIds.includes(businessId)) fail(`Snapshot active rows contain an unowned tenant in ${service}.${table}`);
      }
    }
    data.pendingOutbox = data.tables.service_outbox.source.filter(json => JSON.parse(json).published_at === null).length;
    result.services[service] = data;
  }
  return result;
}
function checkSnapshotEnvironment(snapshot, secrets) {
  if (JSON.stringify(snapshot.targets) !== JSON.stringify(targetIdentity(secrets))) fail('Snapshot belongs to different hosted service databases');
  for (const [key, fingerprint] of Object.entries(snapshot.keyFingerprints)) {
    if (digest(decodeKey(secrets[key], key === 'PAYMENT_ENCRYPTION_KEY' ? 'payment' : 'tenant')) !== fingerprint) fail('Hosted connector encryption key changed since this snapshot');
  }
  if (!Array.isArray(snapshot.businessIds) || snapshot.businessIds.some(value => !uuid.test(value)) || new Set(snapshot.businessIds).size !== snapshot.businessIds.length) fail('Invalid snapshot tenant list');
  if (command === 'apply') {
    for (const service of services) {
      for (const [table, rows] of Object.entries(snapshot.services[service].tables)) {
        if (rows.expected.some(json => Buffer.byteLength(json, 'utf8') + 2 > 4 * 1024 * 1024)) fail(`Snapshot row exceeds 4 MiB import bound in ${service}.${table}`);
      }
    }
  }
}
async function targetTenants(secrets, sourceIds) {
  const client = await hostedClient('platform', secrets);
  try {
    await sessionSettings(client);
    const directoryIds = (await client.query('SELECT DISTINCT business_id::text FROM identity_business_directory')).rows.map(row => row.business_id);
    await client.query('ROLLBACK');
    return [...new Set([...sourceIds, ...directoryIds])].sort();
  } finally { await client.end(); }
}
async function inspectService(client, service, snapshot, tenants) {
  const data = snapshot.services[service], schema = await metadata(client);
  const differences = Object.keys(schema).filter(key => JSON.stringify(schema[key]) !== JSON.stringify(data.schema[key]));
  if (differences.length) fail(`Schema parity failed for ${service} (${differences.join(',')}); inspect private snapshot DDL metadata`);
  const migrations = (await client.query('SELECT name FROM service_migrations ORDER BY name')).rows.map(row => row.name);
  if (JSON.stringify(migrations) !== JSON.stringify(data.migrations) || JSON.stringify(await migrationFiles(service)) !== JSON.stringify(data.migrationFiles)) fail(`Migration parity failed for ${service}`);
  // Service-owned discovery metadata expands coverage of existing hosted tenants.
  const hints = (await client.query("SELECT DISTINCT event->>'businessId' AS business_id FROM service_outbox")).rows.map(row => row.business_id).filter(Boolean);
  if (service === 'integrations') hints.push(...(await client.query('SELECT business_id::text FROM integration_tenant_directory')).rows.map(row => row.business_id));
  const scopedTenants = [...new Set([...tenants, ...hints])];
  if (scopedTenants.some(value => !uuid.test(value))) fail(`Invalid hosted tenant discovery metadata for ${service}`);
  const tables = {}, counts = {};
  for (const [table, expected] of Object.entries(data.tables)) {
    const rows = await readRows(client, table, scopedTenants, schema);
    tables[table] = { count: rows.length, sha256: tableDigest(rows), matches: rows.length === expected.expectedCount && tableDigest(rows) === expected.expectedSha256 };
    counts[table] = rows.length;
  }
  const exact = Object.values(tables).every(row => row.matches), empty = Object.values(tables).every(row => row.count === 0);
  return { state: exact ? 'exact' : empty ? 'empty' : 'conflict', counts, tables, pendingOutbox: data.pendingOutbox };
}
async function preflight(snapshot, secrets, tenants) {
  const report = {};
  for (const service of services) {
    const client = await hostedClient(service, secrets);
    try {
      await sessionSettings(client);
      report[service] = await inspectService(client, service, snapshot, tenants);
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  }
  return report;
}
function printReport(report) {
  for (const service of services) {
    const item = report[service];
    console.log(`${service}: target=${item.state}; active rows=${Object.values(item.counts).reduce((a,b) => a+b,0)}; source pending outbox=${item.pendingOutbox}`);
  }
}
async function insertTableRows(client, table, rows) {
  const groups = new Map();
  for (const json of rows) {
    const businessId = JSON.parse(json).business_id ?? '';
    if (!groups.has(businessId)) groups.set(businessId, []);
    groups.get(businessId).push(json);
  }
  const maxBytes = 4 * 1024 * 1024;
  for (const [businessId, group] of groups) {
    await client.query("SELECT set_config('app.business_id',$1,true)", [businessId]);
    let chunk = [], bytes = 2;
    const flush = async () => {
      if (!chunk.length) return;
      // Join raw PostgreSQL JSON texts: never roundtrip large numbers through JS.
      await client.query(`INSERT INTO ${tableName(table)} SELECT * FROM jsonb_populate_recordset(NULL::${tableName(table)},$1::jsonb)`, [`[${chunk.join(',')}]`]);
      chunk = [];
      bytes = 2;
    };
    for (const json of group) {
      const size = Buffer.byteLength(json, 'utf8');
      if (size + 2 > maxBytes) fail(`Snapshot row exceeds 4 MiB import bound in ${table}`);
      if (chunk.length >= 100 || bytes + size + (chunk.length ? 1 : 0) > maxBytes) await flush();
      bytes += size + (chunk.length ? 1 : 0);
      chunk.push(json);
    }
    await flush();
  }
}
async function applyService(service, snapshot, secrets, tenants, directory) {
  const client = await hostedClient(service, secrets);
  let committed = false;
  try {
    await sessionSettings(client, false);
    await client.query(`LOCK TABLE ${[...order[service], ...shared, 'service_migrations'].map(tableName).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const before = await inspectService(client, service, snapshot, tenants);
    if (before.state === 'conflict') fail(`Target conflict in ${service}; no rows overwritten`);
    if (before.state === 'empty') {
      for (const table of [...order[service], ...shared]) {
        await insertTableRows(client, table, snapshot.services[service].tables[table].expected);
      }
    }
    const after = await inspectService(client, service, snapshot, tenants);
    if (after.state !== 'exact') fail(`Post-import row verification failed for ${service}`);
    await client.query('COMMIT');
    committed = true;
    await privateJson(join(directory, `${service}.receipt.json`), { version: 1, service, completedAt: new Date().toISOString(), snapshotFileSha256: snapshot.files[service], operation: before.state === 'exact' ? 'already_exact' : 'imported', tables: after.tables });
    console.log(`${service}: ${before.state === 'exact' ? 'already exact' : 'imported and verified'}`);
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    if (committed) fail(`Service ${service} committed but receipt could not be saved; rerun the same snapshot`);
    throw error;
  } finally { await client.end(); }
}
async function main() {
  const secrets = JSON.parse(await readFile(join(root, '.cloudflare', 'secrets.json'), 'utf8'));
  targetIdentity(secrets);
  let snapshot;
  if (snapshotPath) snapshot = await loadSnapshot(snapshotPath);
  else {
    const local = parseEnv(await readFile(join(root, '.env'), 'utf8'));
    snapshot = await capture(local, secrets);
    if (command === 'snapshot') {
      snapshotPath = await saveSnapshot(snapshot);
      snapshot = await loadSnapshot(snapshotPath);
      console.log(`Private snapshot: ${relative(root, snapshotPath)}`);
      const archived = snapshot.orphanTenantRows.reduce((count, row) => count + row.count, 0);
      if (archived) console.log(`Archived ${archived} rows with no Platform business; active copy excludes them. Details remain in the private manifest.`);
    }
  }
  checkSnapshotEnvironment(snapshot, secrets);
  const tenants = await targetTenants(secrets, snapshot.businessIds);
  const report = await preflight(snapshot, secrets, tenants);
  printReport(report);
  if (snapshotPath) await privateJson(join(snapshotPath, `${command}-preflight.json`), { capturedAt: new Date().toISOString(), report });
  const pending = services.reduce((total, service) => total + snapshot.services[service].pendingOutbox, 0);
  if (command === 'verify') {
    if (services.some(service => report[service].state !== 'exact')) fail('Hosted rows do not exactly match the snapshot');
    await privateJson(join(snapshotPath, 'verification.json'), { completedAt: new Date().toISOString(), report });
    console.log('All eight database copies match expected rows. R2 contents and hosted login require separate verification.');
    return;
  }
  if (services.some(service => report[service].state === 'conflict')) fail('Target contains conflicting data; apply is blocked');
  if (pending) fail(`Source has ${pending} pending outbox entries; reconcile them before creating an applicable snapshot`);
  if (command === 'apply') {
    for (const service of services) await applyService(service, snapshot, secrets, tenants, snapshotPath);
    const verified = await preflight(snapshot, secrets, tenants);
    if (services.some(service => verified[service].state !== 'exact')) fail('Final eight-service verification failed; keep writers frozen');
    await privateJson(join(snapshotPath, 'verification.json'), { completedAt: new Date().toISOString(), report: verified });
    console.log('All eight database imports verified. Keep automation and outbound delivery paused until R2, login and interrupted operations are reviewed.');
  } else {
    console.log('Audit complete; no database writes. Tenant coverage uses source IDs and hosted discovery directories/outbox; undiscoverable hosted orphan tenants require a separate administrator audit.');
  }
}
main().catch(error => {
  // PostgreSQL errors can contain row values, credentials, or account data.
  console.error(error.recoverySafe ? error.message : 'Recovery stopped; no error payload printed to protect private data. Check connection, key, permissions and private schema metadata.');
  process.exitCode = 1;
});
