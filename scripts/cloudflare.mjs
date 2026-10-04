import { generateKeyPairSync, randomBytes, createPublicKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const serviceNames = ['platform', 'clients', 'scheduling', 'learning', 'billing', 'payments', 'notifications', 'integrations'];
export const deployOrder = ['platform', 'clients', 'scheduling', 'learning', 'payments', 'integrations', 'billing', 'notifications', 'gateway'];
const directory = join(root, '.cloudflare');
const deploymentPath = join(directory, 'deployment.json');
const secretsPath = join(directory, 'secrets.json');
const token = () => randomBytes(24).toString('hex');
const featureNames = serviceNames.filter(name => name !== 'platform');

function fail(message) { throw new Error(message); }
async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function save(path, value, privateFile = false) {
  await mkdir(dirname(path), { recursive: true, mode: privateFile ? 0o700 : 0o755 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: privateFile ? 0o600 : 0o644 });
  if (privateFile) await chmod(path, 0o600);
}
export function validateDeployment(input, remote = false) {
  const config = { prefix: 'tuts', accountId: '', ...input };
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(config.prefix)) fail('prefix must be a lowercase resource name, at most 30 characters');
  if (config.accountId && !/^[a-f\d]{32}$/i.test(config.accountId)) fail('accountId must be a Cloudflare account ID');
  if (remote && !config.accountId) fail('Set accountId in .cloudflare/deployment.json before remote commands');
  let url;
  try { url = new URL(config.publicUrl); } catch { fail('A publicUrl HTTPS origin is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) fail('publicUrl must be an HTTPS origin without credentials, a path or a port');
  config.publicUrl = url.origin;
  if (config.customDomain) {
    if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/.test(config.customDomain) || !config.customDomain.includes('.')) fail('customDomain must be a DNS hostname');
    if (url.hostname !== config.customDomain) fail('publicUrl must match customDomain when customDomain is configured');
  } else if (!url.hostname.endsWith('.workers.dev')) {
    fail('Without customDomain, publicUrl must be the gateway workers.dev origin');
  }
  return config;
}
export function freshSecrets(existing = {}) {
  if (Boolean(existing.CONTEXT_PRIVATE_KEY) !== Boolean(existing.CONTEXT_PUBLIC_KEY)) fail('Restore the matching context signing key pair');
  const defaults = {};
  if (!existing.CONTEXT_PRIVATE_KEY) {
    const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    defaults.CONTEXT_PRIVATE_KEY = keys.privateKey;
    defaults.CONTEXT_PUBLIC_KEY = keys.publicKey;
  }
  for (const name of ['PLATFORM_INTERNAL_SECRET', 'INTERNAL_RUNTIME_SECRET', 'BETTER_AUTH_SECRET']) defaults[name] = token();
  for (const name of ['PAYMENT_ENCRYPTION_KEY', 'INTEGRATIONS_ENCRYPTION_KEY', 'COMMUNICATIONS_ENCRYPTION_KEY']) defaults[name] = randomBytes(32).toString('base64');
  const secrets = { ...defaults, ...existing, databasePasswords: { ...existing.databasePasswords }, databaseUrls: { ...existing.databaseUrls } };
  for (const name of serviceNames) secrets.databasePasswords[name] ??= token();
  return secrets;
}
function checkSecrets(secrets) {
  for (const name of ['CONTEXT_PRIVATE_KEY', 'CONTEXT_PUBLIC_KEY', 'PLATFORM_INTERNAL_SECRET', 'INTERNAL_RUNTIME_SECRET', 'BETTER_AUTH_SECRET', 'PAYMENT_ENCRYPTION_KEY', 'INTEGRATIONS_ENCRYPTION_KEY', 'COMMUNICATIONS_ENCRYPTION_KEY']) {
    if (typeof secrets[name] !== 'string' || secrets[name].length < 32) fail(`Missing or invalid ${name} in .cloudflare/secrets.json; run init`);
  }
  for (const name of serviceNames) if (!/^[a-f\d]{48}$/i.test(secrets.databasePasswords?.[name] ?? '')) fail(`Missing or invalid database password for ${name}; run init`);
  try {
    const publicKey = createPublicKey(secrets.CONTEXT_PRIVATE_KEY.replace(/\\n/g, '\n')).export({ type: 'spki', format: 'pem' });
    if (publicKey.trim() !== secrets.CONTEXT_PUBLIC_KEY.replace(/\\n/g, '\n').trim()) fail('Context signing keys do not match');
  } catch { fail('Context signing keys are invalid or do not match'); }
  for (const name of ['PAYMENT_ENCRYPTION_KEY', 'INTEGRATIONS_ENCRYPTION_KEY', 'COMMUNICATIONS_ENCRYPTION_KEY']) {
    const value = secrets[name];
    if (Buffer.from(value, /^[a-f\d]{64}$/i.test(value) ? 'hex' : 'base64').length !== 32) fail(`${name} must encode exactly 32 bytes`);
  }
}
async function settings(remote = false) {
  const config = validateDeployment(await json(deploymentPath), remote);
  const secrets = await json(secretsPath);
  await chmod(secretsPath, 0o600);
  checkSecrets(secrets);
  return { config, secrets };
}
export function queueName(config, name, deadLetter = false) { return `${config.prefix}-events-${name}${deadLetter ? '-dead' : ''}`; }
export function sqlName(config, service) { return `${config.prefix.replace(/-/g, '_')}_${service}`; }
export function createConfigs(configInput, subscriptions, projectRoot = root) {
  const config = validateDeployment(configInput);
  const common = {
    compatibility_date: '2026-10-04',
    compatibility_flags: ['nodejs_compat', 'enable_nodejs_http_server_modules'],
    ...(config.accountId ? { account_id: config.accountId } : {}),
    preview_urls: false,
    alias: Object.fromEntries(['class-validator', 'class-transformer', 'class-transformer/storage', '@nestjs/websockets/socket-module', '@nestjs/microservices/microservices-module', '@nestjs/microservices'].map(name => [name, join(projectRoot, 'packages/service-kit/dist/cloudflare-optional.js')])),
    send_metrics: false,
    minify: true,
    // Explicit production variables are retained alongside Worker secrets.
    vars: { TUTS_RUNTIME: 'cloudflare', NODE_ENV: 'production', PUBLIC_APP_URL: config.publicUrl, PUBLIC_GATEWAY_URL: config.publicUrl, INITIAL_BUSINESS_ENTITLEMENTS: featureNames.join(','), ALLOW_OUTBOUND_DELIVERY: 'false', ALLOW_SANDBOX_PAYMENTS: 'false' },
  };
  const output = {};
  for (const name of serviceNames) {
    const producers = subscriptions.filter(subscription => subscription.types.some(type => type.split('.')[0] === name))
      .map(subscription => ({ binding: `EVENTS_${subscription.consumer.toUpperCase()}`, queue: queueName(config, subscription.consumer) }));
    const consumes = subscriptions.some(subscription => subscription.consumer === name);
    output[name] = {
      ...common, name: `${config.prefix}-${name}`, main: join(projectRoot, 'services', name, 'dist/worker.js'), workers_dev: false,
      queues: { ...(producers.length ? { producers } : {}), ...(consumes ? { consumers: [{ queue: queueName(config, name), max_batch_size: 5, max_batch_timeout: 5, max_retries: 5, dead_letter_queue: queueName(config, name, true) }] } : {}) },
      r2_buckets: [{ binding: 'EVENT_PAYLOADS', bucket_name: `${config.prefix}-event-payloads` }, ...(name === 'learning' ? [{ binding: 'UPLOADS', bucket_name: `${config.prefix}-uploads` }] : [])],
      ...(name === 'billing' ? { services: [{ binding: 'SCHEDULING', service: `${config.prefix}-scheduling` }] } : {}),
      ...(name === 'notifications' ? { services: [{ binding: 'CLIENTS', service: `${config.prefix}-clients` }] } : {}),
    };
  }
  output.gateway = {
    ...common, name: `${config.prefix}-gateway`, main: join(projectRoot, 'apps/gateway/dist/worker.js'), workers_dev: true,
    assets: { directory: join(projectRoot, 'apps/web/out'), binding: 'ASSETS', run_worker_first: true },
    services: serviceNames.map(name => ({ binding: name.toUpperCase(), service: `${config.prefix}-${name}` })),
    triggers: { crons: ['*/15 * * * *'] },
    ...(config.customDomain ? { routes: [{ pattern: config.customDomain, custom_domain: true }] } : {}),
  };
  return output;
}
async function contracts() {
  try { return await import('../packages/contracts/dist/index.js'); }
  catch { fail('Build @palladium/contracts before generating deployment config'); }
}
async function generate(config) {
  const { eventConsumerSubscriptions } = await contracts();
  const configs = createConfigs(config, eventConsumerSubscriptions);
  for (const [name, value] of Object.entries(configs)) await save(join(directory, 'generated', name, 'wrangler.json'), value);
  return configs;
}
function configPath(name) { return join(directory, 'generated', name, 'wrangler.json'); }
function redact(output, secrets) {
  if (!secrets) return output;
  let value = output;
  const values = Object.values(secrets).flatMap(item => typeof item === 'string' ? [item] : Object.values(item ?? {}).filter(v => typeof v === 'string'));
  for (const secret of values.sort((a, b) => b.length - a.length)) {
    if (secret.length >= 8) value = value.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]');
  }
  return value;
}
async function run(executable, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'info', WRANGLER_LOG_SANITIZE: 'true', ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (!options.quiet && !options.secrets) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; if (!options.quiet && !options.secrets) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      const safe = redact(output, options.secrets);
      if (code === 0) resolveResult(safe);
      else reject(Object.assign(new Error(`${executable} ${args.slice(0, 3).join(' ')} failed (exit ${code})\n${safe}`), { output: safe, exitCode: code }));
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(options.input ?? '');
  });
}
function wrangler(args, options = {}) { return run('pnpm', ['exec', 'wrangler', ...args], options); }

export function secretsFor(name, secrets) {
  if (name === 'gateway') return Object.fromEntries(['CONTEXT_PRIVATE_KEY', 'PLATFORM_INTERNAL_SECRET', 'INTERNAL_RUNTIME_SECRET'].map(key => [key, secrets[key]]));
  const value = { CONTEXT_PUBLIC_KEY: secrets.CONTEXT_PUBLIC_KEY, INTERNAL_RUNTIME_SECRET: secrets.INTERNAL_RUNTIME_SECRET, DATABASE_URL: secrets.databaseUrls?.[name] };
  if (!value.DATABASE_URL) fail(`Missing ${name} database URL; run migrate before deploy`);
  if (name === 'platform') Object.assign(value, { PLATFORM_INTERNAL_SECRET: secrets.PLATFORM_INTERNAL_SECRET, BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET });
  const encryption = { payments: 'PAYMENT_ENCRYPTION_KEY', integrations: 'INTEGRATIONS_ENCRYPTION_KEY', notifications: 'COMMUNICATIONS_ENCRYPTION_KEY' }[name];
  if (encryption) value[encryption] = secrets[encryption];
  return value;
}
async function build() {
  await run('pnpm', ['--filter', '@palladium/contracts', 'build']);
  await run('pnpm', ['--filter', '@palladium/service-kit', 'build']);
  // Nest decorators must pass through tsc before Wrangler/esbuild.
  await run('pnpm', ['-r', ...[...serviceNames, 'gateway'].flatMap(name => ['--filter', `@palladium/${name}`]), 'build']);
  await run('pnpm', ['--filter', '@palladium/web', 'build'], { env: { TUTS_STATIC_EXPORT: 'true', NEXT_PUBLIC_GATEWAY_URL: '' } });
}
async function bundle(config) {
  await generate(config);
  for (const name of [...serviceNames, 'gateway']) {
    console.log(`Bundling ${name} (local dry run)`);
    await wrangler(['deploy', '--config', configPath(name), '--dry-run', '--outdir', join(directory, 'bundles', name)]);
  }
}
async function ensureResource(args, config, secrets, label) {
  try { await wrangler([...args, '--config', configPath('platform')], { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } }); }
  catch (error) {
    // Only an explicit already-existing resource permits an idempotent continuation.
    if (!/already exists|already been created|already have.*bucket/i.test(error.output ?? '')) {
      console.error(redact(error.output ?? '', secrets));
      throw new Error(`${label} could not be provisioned; verify account access and service enablement`);
    }
  }
  console.log(`${label} ready`);
}
async function provision(config, secrets) {
  await generate(config);
  await wrangler(['whoami'], { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
  const { eventConsumerSubscriptions } = await contracts();
  for (const { consumer } of eventConsumerSubscriptions) {
    await ensureResource(['queues', 'create', queueName(config, consumer), '--message-retention-period-secs', '86400'], config, secrets, `${consumer} event queue`);
    await ensureResource(['queues', 'create', queueName(config, consumer, true), '--message-retention-period-secs', '86400'], config, secrets, `${consumer} dead-letter queue`);
  }
  await ensureResource(['r2', 'bucket', 'create', `${config.prefix}-uploads`, '--location', 'weur'], config, secrets, 'Private upload bucket');
  await ensureResource(['r2', 'bucket', 'create', `${config.prefix}-event-payloads`, '--location', 'weur'], config, secrets, 'Private event payload bucket');
  // This dedicated transport bucket owns its lifecycle policy. Seven days exceed
  // the queues' one-day retention; PostgreSQL keeps authoritative recovery JSON.
  await wrangler(['r2', 'bucket', 'lifecycle', 'set', `${config.prefix}-event-payloads`, '--file', join(root, 'infra/cloudflare/event-payload-lifecycle.json'), '--force', '--config', configPath('platform')], { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
  console.log('Private event payload expiration configured for seven days');
}
function quotedIdentifier(name) {
  if (!/^[a-z][a-z_\d]*$/.test(name)) fail('Invalid SQL identifier');
  return `"${name}"`;
}
export function databaseUrl(adminDatabaseUrl, config, name, password) {
  const url = new URL(adminDatabaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) fail('adminDatabaseUrl must be a PostgreSQL connection URL');
  url.username = sqlName(config, name);
  url.password = password;
  url.pathname = `/${sqlName(config, name)}`;
  if (!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) url.searchParams.set('sslmode', 'require');
  return url.toString();
}
export async function verifyRole(client, role) {
  const result = await client.query(`SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=$1`, [role]);
  const row = result.rows[0];
  if (!row || !row.rolcanlogin || row.rolsuper || row.rolbypassrls || row.rolcreatedb || row.rolcreaterole || row.rolreplication) fail(`Unsafe database privileges for ${role}; use an ordinary SQL role without BYPASSRLS`);
  const membership = await client.query(`SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE child.rolname=$1`, [role]);
  if (membership.rowCount) fail(`${role} has inherited role memberships; remove them before migration`);
}
async function migrationTables(tx, migrationsDirectory) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('palladium-migrations'))");
  await tx.query(`CREATE TABLE IF NOT EXISTS service_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS service_outbox (id uuid PRIMARY KEY, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
    CREATE INDEX IF NOT EXISTS service_outbox_pending ON service_outbox(created_at) WHERE published_at IS NULL;
    CREATE TABLE IF NOT EXISTS service_inbox (consumer text NOT NULL, event_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer,event_id));`);
  for (const name of (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort()) {
    if ((await tx.query('SELECT 1 FROM service_migrations WHERE name=$1', [name])).rowCount) continue;
    await tx.query(await readFile(join(migrationsDirectory, name), 'utf8'));
    await tx.query('INSERT INTO service_migrations(name) VALUES($1)', [name]);
  }
}
async function migrate(config, secrets) {
  if (!secrets.adminDatabaseUrl) fail('Set adminDatabaseUrl in .cloudflare/secrets.json before migrating');
  const adminUrl = new URL(secrets.adminDatabaseUrl);
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol) || !['require', 'verify-ca', 'verify-full'].includes(adminUrl.searchParams.get('sslmode'))) fail('adminDatabaseUrl must require PostgreSQL TLS');
  const admin = new pg.Client({ connectionString: secrets.adminDatabaseUrl, connectionTimeoutMillis: 15000 });
  try {
    await admin.connect();
    const tls = await admin.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    if (!tls.rows[0]?.ssl) fail('Administrative PostgreSQL connection is not encrypted');
    for (const name of serviceNames) {
      const role = sqlName(config, name), quoted = quotedIdentifier(role);
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
        // Passwords are generated hex, never supplied on argv or emitted in logs.
        await admin.query(`CREATE ROLE ${quoted} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secrets.databasePasswords[name]}'`);
      }
      await verifyRole(admin, role);
      const database = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [role]);
      if (!database.rowCount) await admin.query(`CREATE DATABASE ${quoted} OWNER ${quoted}`);
      else if (database.rows[0].owner !== role) fail(`${role} database has a different owner; refusing to change ownership`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoted} FROM PUBLIC`);
      for (const other of serviceNames.filter(service => service !== name)) {
        const otherRole = sqlName(config, other);
        if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [otherRole])).rowCount) await admin.query(`REVOKE CONNECT ON DATABASE ${quoted} FROM ${quotedIdentifier(otherRole)}`);
      }
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted} TO ${quoted}`);
      secrets.databaseUrls[name] = databaseUrl(secrets.adminDatabaseUrl, config, name, secrets.databasePasswords[name]);
      // Persist progress before using the new role, so interrupted setup is repeatable.
      await save(secretsPath, secrets, true);
    }
    for (const name of serviceNames) {
      const role = sqlName(config, name);
      const client = new pg.Client({ connectionString: secrets.databaseUrls[name], connectionTimeoutMillis: 15000 });
      try {
        await client.connect();
        await verifyRole(client, role);
        await client.query('BEGIN');
        try {
          await migrationTables(client, join(root, 'services', name, 'migrations'));
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        for (const other of serviceNames.filter(service => service !== name)) {
          const check = await client.query('SELECT has_database_privilege(current_user,$1,\'CONNECT\') AS allowed', [sqlName(config, other)]);
          if (check.rows[0].allowed) fail(`${role} can connect to another service database`);
        }
        console.log(`${name} migrations applied with an ordinary isolated database role`);
      } finally { await client.end(); }
    }
  } catch (error) {
    // PostgreSQL diagnostics can include SQL/password fragments. Only safe controlled messages survive.
    if (/^(Unsafe database|Administrative PostgreSQL|[a-z_]+ (?:has inherited|database has|can connect))/.test(error.message ?? '')) throw error;
    throw new Error(`Database setup failed${error.code ? ` (PostgreSQL ${error.code})` : ''}; check admin access, role passwords, ownership and migration requirements`);
  } finally { await admin.end(); }
}
export function validateServiceDatabaseUrls(config, secrets) {
  for (const name of serviceNames) {
    let url;
    try { url = new URL(secrets.databaseUrls?.[name]); } catch { fail(`Missing ${name} database URL; run migrate before deploy`); }
    const expected = sqlName(config, name);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== expected || decodeURIComponent(url.pathname) !== `/${expected}` || !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')))
      fail(`${name} database URL must select its own ordinary SQL role/database and require TLS`);
  }
}
async function deploy(config, secrets) {
  validateServiceDatabaseUrls(config, secrets);
  await generate(config);
  // Validate every credential before changing any remote Worker.
  for (const name of deployOrder) secretsFor(name, secrets);
  for (const name of deployOrder) {
    console.log(`Publishing ${name}`);
    await wrangler(['secret', 'bulk', '--config', configPath(name)], { input: JSON.stringify(secretsFor(name, secrets)), quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
    await wrangler(['deploy', '--config', configPath(name)], { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
    console.log(`${name} deployed`);
  }
  console.log(`Gateway deployed at ${config.publicUrl}; verify health, registration and tenant isolation before reporting completion`);
}
function parseArguments(args) {
  const result = {};
  while (args.length) {
    const argument = args.shift();
    if (!argument?.startsWith('--')) fail('Expected a named option');
    const [name, inline] = argument.slice(2).split('=', 2);
    const value = inline ?? args.shift();
    if (!value || value.startsWith('--')) fail(`Missing value for --${name}`);
    if (!['public-url', 'account-id', 'prefix', 'custom-domain'].includes(name)) fail(`Unknown option --${name}`);
    result[name] = value;
  }
  return result;
}
export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'init') {
    const options = parseArguments(args), existing = await json(deploymentPath, {});
    const fields = { 'public-url': 'publicUrl', 'account-id': 'accountId', prefix: 'prefix', 'custom-domain': 'customDomain' };
    for (const [name, value] of Object.entries(options)) existing[fields[name]] = value;
    const config = validateDeployment(existing);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await save(deploymentPath, config);
    await save(secretsPath, freshSecrets(await json(secretsPath, {})), true);
    console.log('Cloudflare deployment settings initialized; existing credentials preserved. Fill accountId and adminDatabaseUrl before remote commands.');
    return;
  }
  if (!['config', 'build', 'bundle', 'provision', 'migrate', 'deploy'].includes(command)) fail('Usage: node scripts/cloudflare.mjs init --public-url HTTPS_ORIGIN [--account-id ID] [--prefix tuts] [--custom-domain HOST] | config | build | bundle | provision | migrate | deploy');
  if (args.length) fail('Only init accepts options; edit .cloudflare/deployment.json for subsequent commands');
  const { config, secrets } = await settings(['provision', 'deploy'].includes(command));
  if (command === 'config') { await generate(config); console.log('Nine Wrangler configurations generated without secrets'); }
  if (command === 'build') await build();
  if (command === 'bundle') await bundle(config);
  if (command === 'provision') await provision(config, secrets);
  if (command === 'migrate') await migrate(config, secrets);
  if (command === 'deploy') await deploy(config, secrets);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
