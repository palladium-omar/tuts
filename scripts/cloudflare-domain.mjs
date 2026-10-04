import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { root, validateDeployment } from './cloudflare.mjs';

const hostname = 'tuts.palladiumscholars.com';
const execute = promisify(execFile);
const statuses = new Set(['initializing', 'pending', 'active', 'deactivated', 'blocked', 'error']);

async function credentials() {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, '.cloudflare', 'cli-config'),
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_SANITIZE: 'true',
  };
  // Logging overrides can contaminate the JSON output or reveal credentials.
  delete env.WRANGLER_LOG;
  try {
    const { stdout } = await execute('pnpm', ['exec', 'wrangler', 'auth', 'token', '--json'], {
      cwd: root, env, timeout: 15_000, maxBuffer: 64 * 1024,
    });
    const auth = JSON.parse(stdout);
    if (!['oauth', 'api_token'].includes(auth.type) || typeof auth.token !== 'string' || !auth.token)
      throw new Error();
    return auth.token;
  } catch {
    throw new Error('Cannot read Wrangler credentials from the project CLI configuration. Authenticate there before using this helper.');
  }
}

function publicStatus(domain) {
  const status = value => statuses.has(value) ? value : 'unknown';
  console.log(JSON.stringify({
    hostname,
    status: status(domain?.status),
    validation: status(domain?.validation_data?.status),
    verification: status(domain?.verification_data?.status),
    ...(domain?.validation_data?.method === 'http' || domain?.validation_data?.method === 'txt'
      ? { validationMethod: domain.validation_data.method } : {}),
  }));
}

async function request(base, token, method, suffix = '', body) {
  try {
    const response = await fetch(`${base}${suffix}`, {
      method,
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    // Parse only bounded JSON. Never expose provider text, headers, or errors.
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Generic failure below. */ }
    if (!response.ok || payload?.success !== true)
      throw Object.assign(new Error(), { httpStatus: response.status });
    return payload.result;
  } catch (error) {
    const detail = Number.isInteger(error.httpStatus) ? ` (HTTP ${error.httpStatus})` : '';
    throw new Error(`Cloudflare Pages ${method} request failed${detail}. Check authentication, Pages permissions, and domain settings.`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...extra] = argv;
  if (!['status', 'attach', 'retry'].includes(command) || extra.length)
    throw new Error('Usage: node scripts/cloudflare-domain.mjs status|attach|retry');
  let config;
  try {
    config = validateDeployment(JSON.parse(await readFile(join(root, '.cloudflare', 'deployment.json'), 'utf8')), true);
  } catch {
    throw new Error('A valid .cloudflare/deployment.json with an account ID and public URL is required.');
  }
  if (config.ingress !== 'pages' || (config.customDomain && config.customDomain !== hostname))
    throw new Error(`This helper requires Pages ingress and permits only ${hostname}.`);
  const token = await credentials();
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.pagesProject}/domains`;
  if (command === 'attach') {
    const domains = await request(base, token, 'GET');
    if (!Array.isArray(domains)) throw new Error('Cloudflare returned an unexpected Pages domain list.');
    const existing = domains.find(domain => domain?.name === hostname);
    publicStatus(existing ?? await request(base, token, 'POST', '', { name: hostname }));
  } else {
    publicStatus(await request(base, token, command === 'retry' ? 'PATCH' : 'GET', `/${hostname}`));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
