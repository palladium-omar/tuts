// Private, lossless row archive before additive migrations. This captures the
// current deployed migration sources and catalog definitions alongside data.
// Temporary SELECT grants live only inside a rolled-back transaction.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';
import { root, serviceNames } from './cloudflare.mjs';
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const sha = value => createHash('sha256').update(value).digest('hex');
const save = async (path, value) => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
if (process.argv.slice(2).join(' ') !== '--writers-frozen') throw new Error('Pause hosted ingress, cron and all queue deliveries first; then pass --writers-frozen.');
const secrets = JSON.parse(await readFile(join(root, '.cloudflare/secrets.json'), 'utf8'));
const directory = join(root, '.cloudflare/recovery', `hosted-${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
let phase = 'setup';
const manifest = { version: 1, createdAt: new Date().toISOString(), format: 'jsonl-lossless', services: {} };
try {
 for (const service of serviceNames.filter(name => secrets.databaseUrls[name])) {
  phase = service;
  const target = new URL(secrets.databaseUrls[service]);
  const url = new URL(secrets.adminDatabaseUrl);
  url.pathname = target.pathname;
  url.searchParams.set('sslmode', 'verify-full');
  if (url.hostname.includes('-pooler')) throw new Error('direct');
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000 });
  Object.assign(client.connectionParameters.ssl, { rejectUnauthorized: true, checkServerIdentity });
  await client.connect();
  try {
   const socket = client.connection.stream;
   if (!socket.encrypted || !socket.authorized || checkServerIdentity(url.hostname, socket.getPeerCertificate())) throw new Error('tls');
   const adminRole = (await client.query('SELECT current_user AS role,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
   if (!adminRole.rolbypassrls) throw new Error('bypass');
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   await client.query("SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3; SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='120s'");
   await client.query(`SET LOCAL ROLE ${quote(decodeURIComponent(target.username))}`);
   await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quote(adminRole.role)}`);
   await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quote(adminRole.role)}`);
   await client.query('RESET ROLE');
   const serviceDir = join(directory, service); await mkdir(serviceDir, {mode:0o700});
   const schema = await metadata(client);
   schema.sequences = (await client.query("SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value::text FROM pg_sequences WHERE schemaname='public'")).rows;
   schema.roles = (await client.query('SELECT current_database() database,current_user role,version() version')).rows;
   await save(join(serviceDir, 'catalog.json'), schema);
   const tables = {};
   for (const row of schema.tables.map(JSON.parse)) {
    const rows = (await client.query(`SELECT to_jsonb(t)::text AS json FROM public.${quote(row.name)} t`)).rows.map(r => r.json).sort();
    const data = rows.map(r => r+'\n').join('');
    // Catalog names are never used as paths.
    const filename = `table-${Object.keys(tables).length}.jsonl`;
    await save(join(serviceDir,filename),data);
    tables[row.name] = {file:filename, rows:rows.length,sha256:sha(data)};
   }
   const applied = (await client.query('SELECT name FROM service_migrations ORDER BY name')).rows.map(r=>r.name);
   await mkdir(join(serviceDir,'migrations'),{mode:0o700});
   const migrations = [];
   for (const name of applied) {
    if (!/^[a-zA-Z0-9_-]+\.sql$/.test(name)) throw new Error('migration path');
    const sql = await readFile(join(root,'services',service,'migrations',name));
    await save(join(serviceDir,'migrations',name),sql.toString('utf8'));
    migrations.push({name,sha256:sha(sql)});
   }
   manifest.services[service] = {database:decodeURIComponent(target.pathname.slice(1)),tables,migrations,catalogSha256:sha(JSON.stringify(schema,null,2))};
   console.log(`${service}: ${Object.keys(tables).length} tables archived privately`);
  } finally { await client.query('ROLLBACK').catch(()=>{}); await client.end(); }
 }
 await save(join(directory,'manifest.json'),manifest);
 await save(join(directory,'RESTORE.md'),'This is a private pre-migration data archive. Recreate an isolated database using the exact archived applied migrations and service-kit base tables; compare catalog.json before loading. Load each JSONL row via jsonb_populate_record into its matching table under an administrator, respecting FK order, then restore sequences and validate row counts and hashes. Do not replay outbox events or send emails during recovery. Restore production only after reviewing newer writes. Database credentials are stored separately in the existing private deployment secrets. Original R2 objects are preserved in their existing private buckets. This archive is not a tested automatic rollback.\n');
 await save(join(directory,'COMPLETE'),new Date().toISOString());
 console.log(`Complete private archive: ${relative(root,directory)}`);
} catch(error) { console.error(`Hosted archive failed during ${phase}${error.code ? ` (${error.code})`:''}; no migration performed by this command.`); process.exitCode=1; }

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
