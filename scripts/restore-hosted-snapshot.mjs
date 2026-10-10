/** Database-only restore to NEW LOCAL isolated databases. No application boot,
 * broker connection, mail, provider calls or R2 access. Archived SQL is trusted
 * code: hashes detect corruption, not a hostile replaced manifest. */
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { serviceNames } from './cloudflare.mjs';
import { metadata } from './snapshot-hosted-data.mjs';
export const qi = value => `"${String(value).replaceAll('"', '""')}"`;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { recoverySafe: true }); };

export function validateTarget(adminUrl, prefix, manifest) {
  const url = new URL(adminUrl);
  if ([...url.searchParams.keys()].some(key => !['sslmode','application_name'].includes(key))) fail('Connection query overrides are refused');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || decodeURIComponent(url.pathname) !== '/postgres') fail('Restore requires a loopback PostgreSQL admin URL using the postgres maintenance database');
  if (!/^restore_[a-z0-9_]{4,30}$/.test(prefix)) fail('Choose an explicit isolated prefix restore_NAME using lowercase letters, numbers and underscores');
  const targets = serviceNames.map(service => `${prefix}_${service}`);
  if (targets.some(name => Object.values(manifest.services).some(source => source.database === name))) fail('Targets must differ from every archived source database');
  return { url, targets };
}
async function privateRead(base, relative) {
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.split(/[\\/]/).some(part => ['..', '.', ''].includes(part))) fail('Unsafe archive path');
  const path = join(base, relative);
  if ((await lstat(path)).isSymbolicLink()) fail('Archive symlinks are refused');
  const actual = await realpath(path);
  if (!actual.startsWith(`${base}${sep}`)) fail('Archive path escapes snapshot');
  return readFile(actual);
}
export async function loadSnapshot(directory) {
  const base = await realpath(directory);
  await privateRead(base, 'COMPLETE');
  const manifest = JSON.parse(await privateRead(base, 'manifest.json'));
  if (manifest.version !== 1 || manifest.format !== 'jsonl-lossless' || Object.keys(manifest.services ?? {}).sort().join(',') !== [...serviceNames].sort().join(',')) fail('A complete ten-service lossless snapshot is required');
  const services = {};
  for (const service of serviceNames) {
    const entry = manifest.services[service];
    const raw = await privateRead(base, `${service}/catalog.json`);
    if (digest(raw) !== entry.catalogSha256) fail(`Catalog integrity failed for ${service}`);
    const catalog = JSON.parse(raw);
    const names = catalog.tables.map(JSON.parse).map(row => row.name).sort();
    if (names.join(',') !== Object.keys(entry.tables).sort().join(',') || new Set(names).size !== names.length || !names.includes('service_migrations')) fail(`Table inventory differs for ${service}`);
    const tables = {};
    for (const [name, table] of Object.entries(entry.tables)) {
      if (!/^table-\d+\.jsonl$/.test(table.file)) fail('Unsafe table archive name');
      const bytes = await privateRead(base, `${service}/${table.file}`);
      if (digest(bytes) !== table.sha256 || (bytes.length && bytes.at(-1) !== 10)) fail(`Table integrity failed for ${service}`);
      const rows = bytes.toString('utf8').split('\n'); rows.pop();
      if (!bytes.length) rows.length = 0;
      if (rows.length !== table.rows) fail(`Row count differs for ${service}`);
      for (const row of rows) { const object = JSON.parse(row); if (!object || typeof object !== 'object' || Array.isArray(object)) fail('Archive row must be an object'); }
      tables[name] = rows;
    }
    const migrations = [];
    const seen = new Set();
    for (const migration of entry.migrations) {
      if (!/^[a-zA-Z0-9_-]+\.sql$/.test(migration.name) || seen.has(migration.name)) fail('Unsafe or duplicate migration name');
      seen.add(migration.name);
      const sql = await privateRead(base, `${service}/migrations/${migration.name}`);
      if (digest(sql) !== migration.sha256) fail(`Migration integrity failed for ${service}`);
      if (/\b(?:COPY\b[\s\S]*?\bPROGRAM|ALTER\s+SYSTEM|CREATE\s+(?:FOREIGN|SERVER)|dblink|lo_import|pg_read_file|pg_write_file)\b/i.test(sql.toString())) fail('External/file-access migration is refused');
      migrations.push(sql.toString('utf8'));
    }
    const applied = tables.service_migrations.map(row => JSON.parse(row).name).sort();
    if (applied.join(',') !== [...seen].sort().join(',')) fail(`Applied migration inventory differs for ${service}`);
    services[service] = { entry, catalog, tables, migrations };
  }
  return { base, manifest, services };
}
export function tableOrder(names, foreignKeys) {
  const remaining = new Set(names), result = [];
  while (remaining.size) {
    const ready = [...remaining].filter(name => !foreignKeys.some(fk => fk.child === name && fk.parent !== name && remaining.has(fk.parent))).sort();
    // Cycles are safe only because all FK constraints are reinstalled and
    // validated after the complete data set is loaded inside the transaction.
    const next = ready.length ? ready : [[...remaining].sort()[0]];
    for (const name of next) { remaining.delete(name); result.push(name); }
  }
  return result;
}
function baseStatements(catalog) {
  const tables = catalog.tables.map(JSON.parse).filter(t => t.name.startsWith('service_'));
  const columns = catalog.columns.map(JSON.parse), constraints = catalog.constraints.map(JSON.parse), indexes = catalog.indexes.map(JSON.parse);
  const sql = [];
  for (const table of tables) {
    const defs = columns.filter(c => c.table_name === table.name).sort((a,b) => a.position-b.position).map(c => {
      if (c.generated || c.identity) fail('Generated runtime base columns require explicit support');
      return `${qi(c.name)} ${c.type}${c.default_value ? ` DEFAULT ${c.default_value}` : ''}${c.not_null ? ' NOT NULL' : ''}`;
    });
    const keys = constraints.filter(c => c.table_name === table.name && c.type !== 'f');
    sql.push(`CREATE TABLE public.${qi(table.name)} (${[...defs,...keys.map(c=>`CONSTRAINT ${qi(c.name)} ${c.definition}`)].join(',')})`);
    for (const index of indexes.filter(i => i.table_name === table.name && ['service_outbox_pending','service_outbox_published','service_request_budgets_expiry'].includes(i.name) && !keys.some(k => k.name === i.name))) sql.push(index.definition);
  }
  return sql;
}
export async function restoreService(client, data) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3; SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='15s'");
    for (const extension of data.catalog.extensions.map(JSON.parse)) {
      if (!['plpgsql','pgcrypto','uuid-ossp','btree_gist'].includes(extension.name)) fail('Unsupported extension in snapshot');
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${qi(extension.name)}`);
    }
    for (const statement of baseStatements(data.catalog)) await client.query(statement);
    for (const sql of data.migrations) await client.query(sql);
    const schema = await metadata(client);
    for (const key of ['tables','columns','constraints','indexes','policies','triggers','functions','extensions']) {
      if (JSON.stringify(schema[key]) !== JSON.stringify(data.catalog[key])) fail(`Restored schema differs in ${key}`);
    }
    const foreignKeys = (await client.query(`SELECT child.relname child,parent.relname parent,k.conname name,pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k JOIN pg_class child ON child.oid=k.conrelid JOIN pg_class parent ON parent.oid=k.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace WHERE n.nspname='public' AND k.contype='f'`)).rows;
    for (const fk of foreignKeys) await client.query(`ALTER TABLE public.${qi(fk.child)} DROP CONSTRAINT ${qi(fk.name)}`);
    for (const table of data.catalog.tables.map(JSON.parse)) {
      if (table.force_rls) await client.query(`ALTER TABLE public.${qi(table.name)} NO FORCE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE public.${qi(table.name)} DISABLE TRIGGER USER`);
    }
    for (const table of tableOrder(Object.keys(data.tables), foreignKeys)) {
      const columns = data.catalog.columns.map(JSON.parse).filter(c => c.table_name === table && !c.generated).sort((a,b)=>a.position-b.position).map(c=>qi(c.name)).join(',');
      // Raw PostgreSQL JSON remains raw: no lossy JavaScript number roundtrip.
      for (const row of data.tables[table]) await client.query(`INSERT INTO public.${qi(table)} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_record(NULL::public.${qi(table)},$1::jsonb)`, [row]);
      const rows = (await client.query(`SELECT to_jsonb(t)::text json FROM public.${qi(table)} t`)).rows.map(r=>r.json).sort();
      const actual = rows.map(r=>r+'\n').join('');
      if (rows.length !== data.entry.tables[table].rows || digest(actual) !== data.entry.tables[table].sha256) fail('Restored rows failed lossless readback');
    }
    for (const fk of foreignKeys) await client.query(`ALTER TABLE public.${qi(fk.child)} ADD CONSTRAINT ${qi(fk.name)} ${fk.definition}`);
    for (const trigger of data.catalog.triggers.map(JSON.parse)) {
      const mode = { O:'ENABLE', A:'ENABLE ALWAYS', R:'ENABLE REPLICA', D:'DISABLE' }[trigger.enabled];
      if (!mode) fail('Unknown trigger state');
      await client.query(`ALTER TABLE public.${qi(trigger.table_name)} ${mode} TRIGGER ${qi(trigger.name)}`);
    }
    for (const table of data.catalog.tables.map(JSON.parse)) if (table.force_rls) await client.query(`ALTER TABLE public.${qi(table.name)} FORCE ROW LEVEL SECURITY`);
    for (const sequence of data.catalog.sequences ?? []) {
      if (sequence.last_value === null || sequence.last_value === undefined || typeof sequence.is_called !== 'boolean') fail('Snapshot lacks exact sequence state; create a new snapshot');
      await client.query('SELECT setval($1::regclass,$2::bigint,$3)', [`public.${qi(sequence.sequencename)}`,sequence.last_value,sequence.is_called]);
      const options = (await client.query("SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value::text FROM pg_sequences WHERE schemaname='public' AND sequencename=$1",[sequence.sequencename])).rows[0];
      const state = (await client.query(`SELECT last_value::text,is_called FROM public.${qi(sequence.sequencename)}`)).rows[0];
      const actual = { ...options, ...state };
      for (const key of Object.keys(sequence)) if (actual[key] !== sequence[key]) fail('Restored sequence state differs');
    }
    const final = await metadata(client);
    for (const key of ['tables','columns','constraints','indexes','policies','triggers','functions','extensions']) if (JSON.stringify(final[key]) !== JSON.stringify(data.catalog[key])) fail('Final schema/RLS verification failed');
    await client.query('COMMIT');
    return { tables: Object.keys(data.tables).length, rows: Object.values(data.tables).reduce((n,rows)=>n+rows.length,0), verified: true };
  } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
}
export async function restoreSnapshot({ directory, adminUrl, prefix }) {
  const started=Date.now();
  const snapshot = await loadSnapshot(directory); // Validate everything before any database is created.
  const { url, targets } = validateTarget(adminUrl, prefix, snapshot.manifest);
  const admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000 });
  const created = [], services = {};
  await admin.connect();
  try {
    if (!(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper) fail('Local restore requires an administrator for exact schema and RLS verification');
    const existing = await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[targets]);
    if (existing.rowCount) fail('Every target database must be new; existing targets are refused');
    for (const [index, service] of serviceNames.entries()) {
      const database = targets[index];
      await admin.query(`CREATE DATABASE ${qi(database)} TEMPLATE template0`);
      created.push(database);
      const target = new URL(url); target.pathname = `/${database}`;
      const client = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis:10000 });
      await client.connect();
      try { services[service] = await restoreService(client,snapshot.services[service]); }
      finally { await client.end(); }
    }
    const receipt = { version:1, completedAt:new Date().toISOString(), manifestSha256:digest(await readFile(join(snapshot.base,'manifest.json'))), prefix, isolatedDatabases:created, services, durationMs:Date.now()-started, limitations:['Database-only: R2 objects and keys/config are not backed up','No scheduler or hosted disaster recovery guarantee','Applications and outbound delivery were never started'] };
    await writeFile(join(snapshot.base,`restore-${prefix}.receipt.json`),JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
    return receipt;
  } catch (error) {
    // Preserve newly created isolated targets for inspection; never drop a database automatically.
    throw Object.assign(new Error(error.recoverySafe ? error.message : `Isolated restore stopped${/^[A-Z0-9]{5}$/.test(error.code ?? '') ? ` (SQLSTATE ${error.code})` : ''}; private database error details withheld`),{ recoverySafe:true,createdDatabases:created });
  } finally { await admin.end(); }
}
async function main() {
  const args = process.argv.slice(2), values = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--snapshot','--admin-url','--admin-url-file','--prefix'].includes(flag) || !args[0] || args[0].startsWith('--')) fail('Usage: --snapshot PATH --admin-url LOCAL_POSTGRES_URL --prefix restore_NAME');
    if (values[flag]) fail('Duplicate restore option');
    values[flag] = args.shift();
  }
  if (!values['--snapshot'] || !values['--prefix'] || Boolean(values['--admin-url']) === Boolean(values['--admin-url-file'])) fail('Restore requires snapshot, one local admin URL source and explicit prefix');
  if(values['--admin-url-file']) {
    const info=await lstat(values['--admin-url-file']);
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))fail('Admin URL file must be a private regular file (mode 600)');
    values['--admin-url']=(await readFile(values['--admin-url-file'],'utf8')).trim();
  }
  const receipt = await restoreSnapshot({directory:resolve(values['--snapshot']),adminUrl:values['--admin-url'],prefix:values['--prefix']});
  console.log(`Verified all ${Object.keys(receipt.services).length} isolated service databases; R2 and key recovery remain separate.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.recoverySafe ? error.message : 'Restore stopped; private error details withheld');process.exitCode=1;});
