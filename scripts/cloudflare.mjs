import { generateKeyPairSync, randomBytes, createPublicKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const serviceNames = ['platform', 'clients', 'scheduling', 'learning', 'billing', 'payments', 'notifications', 'integrations', 'planning', 'reporting'];
export const deployOrder = ['platform', 'clients', 'scheduling', 'learning', 'payments', 'integrations', 'billing', 'notifications', 'planning', 'reporting', 'gateway'];
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
  const config = { prefix: 'tuts', accountId: '', ingress: 'worker', ...input };
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(config.prefix)) fail('prefix must be a lowercase resource name, at most 30 characters');
  if (!['worker', 'pages'].includes(config.ingress)) fail('ingress must be worker or pages');
  if (config.authMailEnabled !== undefined && typeof config.authMailEnabled !== 'boolean') fail('authMailEnabled must be a boolean');
  if (config.databaseRegion !== undefined && !/^(aws|gcp|azure):[a-z][a-z0-9-]{1,63}$/.test(config.databaseRegion)) fail('databaseRegion must be a supported cloud provider region');
  if (config.ingress === 'pages') {
    if (typeof config.pagesProject !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,56}[a-z\d])?$/.test(config.pagesProject)) fail('pagesProject must be a lowercase Pages project name, at most 58 characters');
  }
  if (config.accountId && !/^[a-f\d]{32}$/i.test(config.accountId)) fail('accountId must be a Cloudflare account ID');
  if (remote && !config.accountId) fail('Set accountId in .cloudflare/deployment.json before remote commands');
  let url;
  try { url = new URL(config.publicUrl); } catch { fail('A publicUrl HTTPS origin is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) fail('publicUrl must be an HTTPS origin without credentials, a path or a port');
  config.publicUrl = url.origin;
  if (config.customDomain) {
    if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/.test(config.customDomain) || !config.customDomain.includes('.')) fail('customDomain must be a DNS hostname');
    if (url.hostname !== config.customDomain) fail('publicUrl must match customDomain when customDomain is configured');
  } else if (!url.hostname.endsWith(config.ingress === 'pages' ? '.pages.dev' : '.workers.dev')) {
    fail(`Without customDomain, publicUrl must be the ${config.ingress === 'pages' ? 'Pages pages.dev' : 'gateway workers.dev'} origin`);
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
  for (const name of ['PLATFORM_INTERNAL_SECRET', 'INTERNAL_RUNTIME_SECRET', 'BETTER_AUTH_SECRET', 'AUTH_MAIL_INTERNAL_SECRET', 'PORTAL_INTERNAL_SECRET']) defaults[name] = token();
  for (const name of ['PAYMENT_ENCRYPTION_KEY', 'INTEGRATIONS_ENCRYPTION_KEY', 'COMMUNICATIONS_ENCRYPTION_KEY']) defaults[name] = randomBytes(32).toString('base64');
  const secrets = { ...defaults, ...existing, databasePasswords: { ...existing.databasePasswords }, databaseUrls: { ...existing.databaseUrls } };
  for (const name of serviceNames) secrets.databasePasswords[name] ??= token();
  return secrets;
}
function checkSecrets(secrets) {
  for (const name of ['CONTEXT_PRIVATE_KEY', 'CONTEXT_PUBLIC_KEY', 'PLATFORM_INTERNAL_SECRET', 'INTERNAL_RUNTIME_SECRET', 'BETTER_AUTH_SECRET', 'AUTH_MAIL_INTERNAL_SECRET', 'PORTAL_INTERNAL_SECRET', 'PAYMENT_ENCRYPTION_KEY', 'INTEGRATIONS_ENCRYPTION_KEY', 'COMMUNICATIONS_ENCRYPTION_KEY']) {
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
  if (config.authMailEnabled && (secrets.AUTH_MAIL_PROVIDER !== 'resend' || !secrets.AUTH_MAIL_FROM || !secrets.AUTH_MAIL_API_KEY))
    fail('Automatic auth mail requires a configured Resend sender and API key before authMailEnabled can be true');
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
    // Keep recovery tokens out of URL metadata. Application records use only
    // normalized routes and an explicit safe field allowlist.
    observability: {
      enabled: true, redact_query_string: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false, persist: true },
      traces: { enabled: false },
    },
    upload_source_maps: true,
    alias: Object.fromEntries(['class-validator', 'class-transformer', 'class-transformer/storage', '@nestjs/websockets/socket-module', '@nestjs/microservices/microservices-module', '@nestjs/microservices'].map(name => [name, join(projectRoot, 'packages/service-kit/dist/cloudflare-optional.js')])),
    send_metrics: false,
    minify: true,
    // Explicit production variables are retained alongside Worker secrets.
    vars: { TUTS_RUNTIME: 'cloudflare', NODE_ENV: 'production', PUBLIC_APP_URL: config.publicUrl, PUBLIC_GATEWAY_URL: config.publicUrl, PUBLIC_REPORTING_BASE_URL: `${config.publicUrl}/api/reporting`, INITIAL_BUSINESS_ENTITLEMENTS: featureNames.join(','), ALLOW_OUTBOUND_DELIVERY: 'false', ALLOW_SANDBOX_PAYMENTS: 'false' },
  };
  const output = {};
  for (const name of serviceNames) {
    const producers = subscriptions.filter(subscription => subscription.types.some(type => type.split('.')[0] === name))
      .map(subscription => ({ binding: `EVENTS_${subscription.consumer.toUpperCase()}`, queue: queueName(config, subscription.consumer) }));
    const consumes = subscriptions.some(subscription => subscription.consumer === name);
    output[name] = {
      ...common, name: `${config.prefix}-${name}`, main: join(projectRoot, 'services', name, 'dist/worker.js'), workers_dev: false,
      // ExcelJS's browser build embeds a nextTick queue that can stall after
      // the first request. Workers has Node compatibility; select that entry.
      ...(['clients', 'billing'].includes(name) ? { alias: { ...common.alias, exceljs: join(projectRoot, 'services', name, 'node_modules/exceljs/excel.js') } } : {}),
      ...(config.databaseRegion ? { placement: { region: config.databaseRegion } } : {}),
      ...(['platform', 'notifications'].includes(name) ? { vars: { ...common.vars, AUTH_MAIL_ENABLED: config.authMailEnabled ? 'true' : 'false' } } : {}),
      queues: { ...(producers.length ? { producers } : {}), ...(consumes ? { consumers: [{ queue: queueName(config, name), max_batch_size: 5, max_batch_timeout: 5, max_retries: 5, dead_letter_queue: queueName(config, name, true) }] } : {}) },
      r2_buckets: [{ binding: 'EVENT_PAYLOADS', bucket_name: `${config.prefix}-event-payloads` }, ...(name === 'learning' ? [{ binding: 'UPLOADS', bucket_name: `${config.prefix}-uploads` }] : [])],
      ...(name === 'reporting' ? { services: ['scheduling', 'learning', 'billing', 'clients'].map(service => ({ binding: service.toUpperCase(), service: `${config.prefix}-${service}` })) } : {}),
      ...(name === 'billing' ? { services: [{ binding: 'SCHEDULING', service: `${config.prefix}-scheduling` }] } : {}),
      ...(['integrations', 'planning'].includes(name) ? { services: [{ binding: 'CLIENTS', service: `${config.prefix}-clients` }] } : {}),
      ...(name === 'notifications' ? { services: [{ binding: 'CLIENTS', service: `${config.prefix}-clients` }] } : {}),
      ...(name === 'platform' ? { services: [{ binding: 'NOTIFICATIONS', service: `${config.prefix}-notifications` }, { binding: 'CLIENTS', service: `${config.prefix}-clients` }] } : {}),
    };
  }
  output.gateway = {
    ...common, name: `${config.prefix}-gateway`, main: join(projectRoot, 'apps/gateway/dist/worker.js'), workers_dev: config.ingress === 'worker',
    assets: { directory: join(projectRoot, 'apps/web/out'), binding: 'ASSETS', run_worker_first: true },
    services: serviceNames.map(name => ({ binding: name.toUpperCase(), service: `${config.prefix}-${name}` })),
    triggers: { crons: ['*/15 * * * *'] },
    ...(config.customDomain && config.ingress === 'worker' ? { routes: [{ pattern: config.customDomain, custom_domain: true }] } : {}),
  };
  if (config.ingress === 'pages') {
    // Pages has its own supported config fields and takes the account from the
    // deployment environment. It receives no database, queue or secret bindings.
    output.pages = {
      name: config.pagesProject,
      pages_build_output_dir: join(projectRoot, '.cloudflare/generated/pages/dist'),
      compatibility_date: common.compatibility_date,
      send_metrics: false,
      services: [{ binding: 'GATEWAY', service: `${config.prefix}-gateway` }],
    };
  }
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
  if (configs.pages) {
    const outputDirectory = configs.pages.pages_build_output_dir;
    await mkdir(outputDirectory, { recursive: true });
    for (const name of ['_worker.js', '_routes.json'])
      await copyFile(join(root, 'infra/cloudflare/pages-proxy', name), join(outputDirectory, name));
  }
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
function wrangler(args, options = {}) {
  // Wrangler's explicit info log level suppresses machine-readable --json output.
  const env = { ...(args.includes('--json') ? { WRANGLER_LOG: undefined } : {}), ...options.env };
  return run('pnpm', ['exec', 'wrangler', ...args], { ...options, env });
}

export function secretsFor(name, secrets) {
  if (name === 'gateway') return Object.fromEntries(['CONTEXT_PRIVATE_KEY', 'PLATFORM_INTERNAL_SECRET', 'INTERNAL_RUNTIME_SECRET'].map(key => [key, secrets[key]]));
  const value = { CONTEXT_PUBLIC_KEY: secrets.CONTEXT_PUBLIC_KEY, INTERNAL_RUNTIME_SECRET: secrets.INTERNAL_RUNTIME_SECRET, DATABASE_URL: secrets.databaseUrls?.[name] };
  if (!value.DATABASE_URL) fail(`Missing ${name} database URL; run migrate before deploy`);
  if (name === 'platform') Object.assign(value, { PLATFORM_INTERNAL_SECRET: secrets.PLATFORM_INTERNAL_SECRET, BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET });
  if (['platform', 'notifications'].includes(name)) value.AUTH_MAIL_INTERNAL_SECRET = secrets.AUTH_MAIL_INTERNAL_SECRET;
  if (['platform', 'clients', 'integrations'].includes(name)) value.PORTAL_INTERNAL_SECRET = secrets.PORTAL_INTERNAL_SECRET;
  if (name === 'notifications') for (const key of ['AUTH_MAIL_PROVIDER', 'AUTH_MAIL_FROM', 'AUTH_MAIL_API_KEY']) {
    if (typeof secrets[key] === 'string' && secrets[key]) value[key] = secrets[key];
  }
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
  if (config.ingress === 'pages') {
    console.log('Bundling Pages ingress (local compilation)');
    await wrangler(['pages', 'functions', 'build',
      '--build-output-directory', join(directory, 'generated/pages/dist'),
      '--outdir', join(directory, 'bundles/pages'), '--compatibility-date', '2026-10-04']);
  }
}
async function ensurePagesProject(config, secrets) {
  const options = { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } };
  // Pages commands discover their config from --cwd; --config is unsupported.
  const pagesDirectory = join(directory, 'generated/pages');
  const findProject = async () => {
    const output = await wrangler(['pages', 'project', 'list', '--json', '--cwd', pagesDirectory], options);
    let projects;
    try { projects = JSON.parse(output); } catch { fail('Could not read Pages projects; verify account access'); }
    if (!Array.isArray(projects)) fail('Could not read Pages projects; verify account access');
    return projects.find(project => (project['Project Name'] ?? project.name) === config.pagesProject);
  };
  let project = await findProject();
  if (!project) {
    // Wrangler can automatically delegate new Pages projects to Workers. This
    // ingress explicitly requires Pages' support for externally hosted DNS.
    await wrangler(['pages', 'project', 'create', config.pagesProject,
      '--production-branch', 'main', '--force', '--cwd', pagesDirectory], options);
    project = await findProject();
  }
  if (!project) fail('Pages project was not found after creation; verify account access');
  const domains = project.domains ?? String(project['Project Domains'] ?? '').split(',').map(domain => domain.trim());
  const stagingDomain = Array.isArray(domains) && domains.find(domain => typeof domain === 'string' && /^[a-z\d-]+\.pages\.dev$/.test(domain));
  if (!config.customDomain && stagingDomain && config.publicUrl !== `https://${stagingDomain}`)
    fail(`Pages staging origin differs; set publicUrl to https://${stagingDomain} and regenerate configuration before deploying`);
  if (stagingDomain) console.log(`Pages staging origin: https://${stagingDomain}`);
  console.log('Pages ingress project ready; existing projects must use main as their production branch');
}
async function ensureResource(args, config, secrets, label) {
  try { await wrangler([...args, '--config', configPath('platform')], { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } }); }
  catch (error) {
    // Only an explicit already-existing resource permits an idempotent continuation.
    const existingQueue = args[0] === 'queues' && args[1] === 'create' && /Queue name '[^']+' is already taken[\s\S]*code: 11009/.test(error.output ?? '');
    if (!existingQueue && !/already exists|already been created|already have.*bucket/i.test(error.output ?? '')) {
      console.error(redact(error.output ?? '', secrets));
      throw new Error(`${label} could not be provisioned; verify account access and service enablement`);
    }
  }
  console.log(`${label} ready`);
}
// Account namespace registration is required by queue consumers even when every
// Worker disables public workers.dev and preview routes. Preserve existing names.
// https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/
export async function ensureWorkersSubdomain(config) {
  const auth = await new Promise((resolveAuth, reject) => {
    const child = spawn('pnpm', ['exec', 'wrangler', 'auth', 'token', '--json'], {
      cwd: root,
      env: { ...process.env, CI: 'true', CLOUDFLARE_ACCOUNT_ID: config.accountId, WRANGLER_LOG: undefined, WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Authentication output is secret: never echo, persist, or include it in errors.
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Could not capture authorized Wrangler authentication')));
    child.on('close', code => {
      if (code !== 0) { reject(new Error('Could not capture authorized Wrangler authentication')); return; }
      try {
        const value = JSON.parse(output);
        if (!['oauth', 'api_token'].includes(value.type) || typeof value.token !== 'string' || !value.token) throw new Error();
        resolveAuth(value);
      } catch { reject(new Error('Wrangler bearer authorization is required for account namespace setup')); }
    });
  });
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/subdomain`;
  async function request(method, payload) {
    const response = await fetch(endpoint, {
      method, headers: { authorization: `Bearer ${auth.token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    return { ok: response.ok && body.success === true, status: response.status, subdomain: body.result?.subdomain, codes: (body.errors ?? []).map(error => error.code) };
  }
  const existing = await request('GET');
  if (existing.ok && typeof existing.subdomain === 'string' && existing.subdomain) {
    console.log(`Account Workers namespace ready: ${existing.subdomain}.workers.dev`);
    return existing.subdomain;
  }
  if (existing.status !== 404 || !existing.codes.includes(10007)) fail(`Could not read account Workers namespace (HTTP ${existing.status}; codes ${existing.codes.join(',')})`);
  const candidates = [...new Set([config.pagesProject ?? `${config.prefix}-palladium`, `${config.prefix}-${config.accountId.slice(0, 8)}`])];
  for (const candidate of candidates) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate)) fail('Invalid account Workers namespace candidate');
    // Re-read before registering to preserve a namespace created concurrently.
    const current = await request('GET');
    if (current.ok && current.subdomain) return current.subdomain;
    if (current.status !== 404 || !current.codes.includes(10007)) fail('Account Workers namespace state changed; refusing to overwrite it');
    const created = await request('PUT', { subdomain: candidate });
    if (!created.ok) {
      if (created.codes.includes(10031)) continue; // This candidate is unavailable.
      fail(`Could not register account Workers namespace (HTTP ${created.status}; codes ${created.codes.join(',')})`);
    }
    const confirmed = await request('GET');
    if (!confirmed.ok || confirmed.subdomain !== candidate) fail('Account Workers namespace registration was not confirmed');
    console.log(`Account Workers namespace ready: ${candidate}.workers.dev`);
    return candidate;
  }
  fail('Account Workers namespace candidates are unavailable; choose an available account namespace');
}
async function provision(config, secrets) {
  await generate(config);
  await wrangler(['whoami'], { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
  await ensureWorkersSubdomain(config);
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
  if (config.ingress === 'pages') await ensurePagesProject(config, secrets);
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
function migrationClient(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.set('sslmode', 'verify-full');
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000 });
  // pg parses URL SSL options before constructing its connection. Harden that
  // shared options object afterward, so URL parsing cannot override validation.
  Object.assign(client.connectionParameters.ssl, { rejectUnauthorized: true, checkServerIdentity });
  return client;
}
function verifyConnectionTls(client, label) {
  const stream = client.connection.stream;
  // Neon terminates client TLS at its proxy; pg_stat_ssl describes the proxy's
  // backend connection, not this client's encrypted and authenticated socket.
  if (stream.encrypted !== true || stream.authorized !== true || stream.authorizationError
    || typeof stream.getPeerCertificate !== 'function'
    || checkServerIdentity(client.connectionParameters.host, stream.getPeerCertificate()))
    fail(`${label} PostgreSQL connection requires verified TLS and a matching hostname`);
}
async function migrate(config, secrets) {
  if (!secrets.adminDatabaseUrl) fail('Set adminDatabaseUrl in .cloudflare/secrets.json before migrating');
  const adminUrl = new URL(secrets.adminDatabaseUrl);
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol) || !['require', 'verify-ca', 'verify-full'].includes(adminUrl.searchParams.get('sslmode'))) fail('adminDatabaseUrl must require PostgreSQL TLS');
  const admin = migrationClient(secrets.adminDatabaseUrl);
  if (admin.connectionParameters.host.includes('-pooler')) fail('Administrative PostgreSQL migrations require a direct endpoint');
  let phase = 'administrative connection';
  try {
    await admin.connect();
    verifyConnectionTls(admin, 'Administrative');
    for (const name of serviceNames) {
      const role = sqlName(config, name), quoted = quotedIdentifier(role);
      phase = `${name} role creation`;
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
        // Passwords are generated hex, never supplied on argv or emitted in logs.
        await admin.query(`CREATE ROLE ${quoted} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secrets.databasePasswords[name]}'`);
      }
      phase = `${name} role verification`;
      await verifyRole(admin, role);
      phase = `${name} database inspection`;
      const database = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [role]);
      if (!database.rowCount) {
        // PostgreSQL requires SET ROLE ability to create a database for another
        // owner. Grant the service role to the administrator, never the reverse.
        phase = `${name} administrator owner permission`;
        const permission = await admin.query("SELECT pg_has_role(current_user,$1,'SET') AS allowed", [role]);
        if (!permission.rows[0]?.allowed) await admin.query(`GRANT ${quoted} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
        phase = `${name} database creation`;
        await admin.query(`CREATE DATABASE ${quoted} OWNER ${quoted}`);
      }
      else if (database.rows[0].owner !== role) fail(`${role} database has a different owner; refusing to change ownership`);
      phase = `${name} database access isolation`;
      // Administrator membership deliberately does not inherit owner rights.
      // Apply ACLs as the owner; otherwise PostgreSQL may only emit a warning.
      await admin.query(`SET ROLE ${quoted}`);
      try {
        await admin.query(`REVOKE CONNECT ON DATABASE ${quoted} FROM PUBLIC`);
        for (const other of serviceNames.filter(service => service !== name)) {
          const otherRole = sqlName(config, other);
          if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [otherRole])).rowCount) await admin.query(`REVOKE CONNECT ON DATABASE ${quoted} FROM ${quotedIdentifier(otherRole)}`);
        }
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted} TO ${quoted}`);
      } finally { await admin.query('RESET ROLE'); }
      secrets.databaseUrls[name] = databaseUrl(secrets.adminDatabaseUrl, config, name, secrets.databasePasswords[name]);
      // Persist progress before using the new role, so interrupted setup is repeatable.
      phase = `${name} credential persistence`;
      await save(secretsPath, secrets, true);
    }
    for (const name of serviceNames) {
      const role = sqlName(config, name);
      const client = migrationClient(secrets.databaseUrls[name]);
      try {
        phase = `${name} service connection`;
        await client.connect();
        verifyConnectionTls(client, 'Service');
        phase = `${name} service role verification`;
        await verifyRole(client, role);
        phase = `${name} schema migration`;
        await client.query('BEGIN');
        try {
          await migrationTables(client, join(root, 'services', name, 'migrations'));
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        phase = `${name} database access verification`;
        for (const other of serviceNames.filter(service => service !== name)) {
          const check = await client.query('SELECT has_database_privilege(current_user,$1,\'CONNECT\') AS allowed', [sqlName(config, other)]);
          if (check.rows[0].allowed) fail(`${role} can connect to another service database`);
        }
        console.log(`${name} schema migrations applied with an ordinary isolated database role; existing account and business records are not copied by this command`);
      } finally { await client.end(); }
    }
  } catch (error) {
    // PostgreSQL diagnostics can include SQL/password fragments. Only safe controlled messages survive.
    if (/^(Unsafe database|(?:Administrative|Service) PostgreSQL|[a-z_]+ (?:has inherited|database has|can connect))/.test(error.message ?? '')) throw error;
    throw new Error(`Database setup failed during ${phase}${error.code ? ` (PostgreSQL ${error.code})` : ''}; check admin access, role passwords, ownership and migration requirements`);
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
  if (config.ingress === 'pages') await ensurePagesProject(config, secrets);
  for (const name of deployOrder) {
    console.log(`Publishing ${name}`);
    await wrangler(['secret', 'bulk', '--config', configPath(name)], { input: JSON.stringify(secretsFor(name, secrets)), quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
    await wrangler(['deploy', '--config', configPath(name)], { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
    console.log(`${name} deployed`);
  }
  if (config.ingress === 'pages') {
    console.log('Publishing Pages ingress');
    await wrangler(['pages', 'deploy', '--project-name', config.pagesProject,
      '--branch', 'main', '--force', '--cwd', join(directory, 'generated/pages')],
      { quiet: true, secrets, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
    console.log(`Pages ingress published for ${config.publicUrl}; associate its custom domain and verify DNS, health, registration and tenant isolation before reporting completion`);
  } else {
    console.log(`Gateway deployed at ${config.publicUrl}; verify health, registration and tenant isolation before reporting completion`);
  }
}
function parseArguments(args) {
  const result = {};
  while (args.length) {
    const argument = args.shift();
    if (!argument?.startsWith('--')) fail('Expected a named option');
    const [name, inline] = argument.slice(2).split('=', 2);
    const value = inline ?? args.shift();
    if (!value || value.startsWith('--')) fail(`Missing value for --${name}`);
    if (!['public-url', 'account-id', 'prefix', 'custom-domain', 'ingress', 'pages-project'].includes(name)) fail(`Unknown option --${name}`);
    result[name] = value;
  }
  return result;
}
export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'init') {
    const options = parseArguments(args), existing = await json(deploymentPath, {});
    const fields = { 'public-url': 'publicUrl', 'account-id': 'accountId', prefix: 'prefix', 'custom-domain': 'customDomain', ingress: 'ingress', 'pages-project': 'pagesProject' };
    for (const [name, value] of Object.entries(options)) {
      if (name === 'custom-domain' && value === 'none') delete existing.customDomain;
      else existing[fields[name]] = value;
    }
    const config = validateDeployment(existing);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await save(deploymentPath, config);
    await save(secretsPath, freshSecrets(await json(secretsPath, {})), true);
    console.log('Cloudflare deployment settings initialized; existing credentials preserved. Fill accountId and adminDatabaseUrl before remote commands.');
    return;
  }
  if (!['config', 'build', 'bundle', 'provision', 'migrate', 'deploy'].includes(command)) fail('Usage: node scripts/cloudflare.mjs init --public-url HTTPS_ORIGIN [--account-id ID] [--prefix tuts] [--custom-domain HOST] [--ingress worker|pages] [--pages-project NAME] | config | build | bundle | provision | migrate | deploy');
  if (args.length) fail('Only init accepts options; edit .cloudflare/deployment.json for subsequent commands');
  const { config, secrets } = await settings(['provision', 'deploy'].includes(command));
  if (command === 'config') { const configs = await generate(config); console.log(`${Object.keys(configs).length} Wrangler configurations generated without secrets`); }
  if (command === 'build') await build();
  if (command === 'bundle') await bundle(config);
  if (command === 'provision') await provision(config, secrets);
  if (command === 'migrate') await migrate(config, secrets);
  if (command === 'deploy') await deploy(config, secrets);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
