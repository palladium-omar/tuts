import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { root, validateDeployment } from './cloudflare.mjs';

// Only contract event-consumer queues; dead-letter queues have no consumers.
const consumers = ['billing', 'integrations', 'clients', 'scheduling', 'payments', 'notifications', 'learning', 'planning', 'reporting'];
const directory = join(root, '.cloudflare', 'recovery');
const statePath = join(directory, 'maintenance-state.json');
const configPath = join(root, '.cloudflare', 'generated', 'gateway', 'wrangler.json');
const execute = promisify(execFile);
const phases = ['pausing', 'paused', 'resuming', 'resumed'];
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = message => { throw new Error(message); };

function cliEnv(config) {
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, '.cloudflare', 'cli-config'),
    CLOUDFLARE_ACCOUNT_ID: config.accountId, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true' };
  delete env.WRANGLER_LOG;
  return env;
}
async function credentials(config) {
  try {
    const { stdout } = await execute('pnpm', ['exec', 'wrangler', 'auth', 'token', '--json'], {
      cwd: root, env: cliEnv(config), timeout: 15_000, maxBuffer: 64 * 1024,
    });
    const auth = JSON.parse(stdout);
    if (!['oauth', 'api_token'].includes(auth.type) || typeof auth.token !== 'string' || !auth.token) throw new Error();
    return auth.token;
  } catch { fail('Cannot read project Wrangler credentials. Authenticate before using this helper.'); }
}
async function request(config, token, method, suffix, body) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}${suffix}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
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
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok || payload.success !== true) throw new Error();
    return payload.result;
  } catch { fail(`Cloudflare ${method} operation failed. Maintenance state is retained; resolve permissions or connectivity and rerun the command.`); }
}
function schedules(result) {
  if (!Array.isArray(result?.schedules) || result.schedules.some(item => typeof item?.cron !== 'string' || !item.cron || item.cron.length > 256))
    fail('Unexpected gateway schedule response.');
  return result.schedules.map(item => ({ cron: item.cron })).sort((a, b) => a.cron.localeCompare(b.cron));
}
function queueSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.delivery_paused !== undefined && typeof value.delivery_paused !== 'boolean')) fail('Unexpected queue settings.');
  const output = { delivery_paused: value.delivery_paused ?? false };
  for (const key of ['delivery_delay', 'message_retention_period']) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail('Unexpected queue settings.');
      output[key] = value[key];
    }
  }
  if (Object.keys(value).some(key => !['delivery_paused', 'delivery_delay', 'message_retention_period'].includes(key)))
    fail('Queue has unsupported settings; review before changing delivery.');
  return output;
}
function queue(item, name) {
  if (item?.queue_name !== name || !/^[a-f\d]{32}$/i.test(item.queue_id ?? '')) fail('Unexpected event queue identity.');
  return { id: item.queue_id, name, settings: queueSettings(item.settings) };
}
async function controls(config, token, original) {
  const gateway = `${config.prefix}-gateway`;
  const current = { schedules: schedules(await request(config, token, 'GET', `/workers/scripts/${gateway}/schedules`)), queues: [] };
  for (const consumer of consumers) {
    const name = `${config.prefix}-events-${consumer}`;
    const saved = original?.queues.find(item => item.name === name);
    let item;
    if (saved) item = await request(config, token, 'GET', `/queues/${saved.id}`);
    else {
      const matches = await request(config, token, 'GET', `/queues?name=${encodeURIComponent(name)}`);
      if (!Array.isArray(matches)) fail('Unexpected event queue list.');
      const exact = matches.filter(item => item?.queue_name === name);
      if (exact.length !== 1) fail(`Expected exactly one ${name} event queue.`);
      item = exact[0];
    }
    current.queues.push(queue(item, name));
  }
  return current;
}
async function probe(config) {
  try {
    const response = await fetch(`${config.publicUrl}/health`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    if (text.length > 4096) throw new Error();
    const body = JSON.parse(text);
    if (response.status === 503 && response.headers.get('x-tuts-maintenance') === 'true' && body?.error?.code === 'maintenance') return true;
    if (response.status === 200 && body?.service === 'gateway' && body?.status === 'ok') return false;
  } catch { /* Fail closed without exposing response bodies or URLs. */ }
  fail('Public gateway state is unexpected or unreachable. Deploy maintenance support and verify ingress before continuing.');
}
async function setMaintenance(config, token, enabled) {
  // Input and all Wrangler output remain private. Never print captured stderr.
  await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'wrangler', 'secret', 'put', 'TUTS_MAINTENANCE', '--config', configPath], {
      cwd: root, env: { ...cliEnv(config), CLOUDFLARE_API_TOKEN: token }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Maintenance secret update timed out; rerun to resolve its uncertain outcome.')); }, 60_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Cannot run Wrangler maintenance secret update.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('Wrangler maintenance secret update failed; prior maintenance state is retained.')); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { clearTimeout(timer); reject(new Error('Cannot provide maintenance flag to Wrangler.')); } });
    child.stdin.end(`${enabled ? 'true' : 'false'}\n`);
  });
  for (let attempt = 0; attempt < 15; attempt++) {
    try { if (await probe(config) === enabled) return; } catch { /* Allow deployment propagation. */ }
    await new Promise(accept => setTimeout(accept, 2000));
  }
  fail('Maintenance flag has not been verified at public ingress. State is retained; rerun before recovery or reopening.');
}
async function save(state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}
async function load(config) {
  let state;
  try {
    const info = await lstat(statePath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail('Maintenance state must be a private regular file (0600).');
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return; throw new Error('Maintenance state is unreadable or unsafe; preserve it and review before continuing.'); }
  if (state.version !== 1 || !phases.includes(state.phase) || state.accountId !== config.accountId ||
      state.prefix !== config.prefix || state.publicUrl !== config.publicUrl || !Array.isArray(state.original?.queues) || state.original.queues.length > consumers.length || !state.original.queues.length)
    fail('Saved maintenance state does not match this deployment.');
  state.original.schedules = schedules({ schedules: state.original.schedules });
  const expected = new Set(consumers.map(consumer => `${config.prefix}-events-${consumer}`));
  const seen = new Set();
  for (const [index, item] of state.original.queues.entries()) {
    if (!expected.has(item.name) || seen.has(item.name)) fail('Saved maintenance queue identity is invalid.');
    seen.add(item.name);
    state.original.queues[index] = queue({ queue_id: item.id, queue_name: item.name, settings: item.settings }, item.name);
  }
  if (state.original.queues.length !== consumers.length && state.phase !== 'resumed') fail('Finish the existing maintenance operation before expanding queue topology.');
  return state;
}
function validateCurrent(current, state) {
  if (current.schedules.length && !equal(current.schedules, state.original.schedules)) fail('Gateway schedules changed unexpectedly; restore decision requires review.');
  for (const [index, item] of current.queues.entries()) {
    const saved = state.original.queues[index];
    const allowed = [{ ...saved.settings, delivery_paused: true }, saved.settings];
    if (item.id !== saved.id || !allowed.some(settings => equal(settings, item.settings))) fail('An event queue changed unexpectedly; restore decision requires review.');
  }
}
async function setControls(config, token, current, target) {
  if (!equal(current.schedules, target.schedules))
    await request(config, token, 'PUT', `/workers/scripts/${config.prefix}-gateway/schedules`, target.schedules);
  for (const [index, saved] of target.queues.entries()) {
    if (!equal(current.queues[index].settings, saved.settings))
      await request(config, token, 'PUT', `/queues/${saved.id}`, { queue_name: saved.name, settings: saved.settings });
  }
  const verified = await controls(config, token, target);
  if (!equal(verified, target)) fail('Queue or schedule controls have not been verified. Maintenance remains enabled; rerun before continuing.');
}
async function pauseAfterResumeFailure(config, token, state) {
  // Do not stop at the first failure: every background control needs its own
  // pause attempt, including controls already restored earlier in the resume.
  try { await setMaintenance(config, token, true); } catch { /* Verify again below. */ }
  const schedulePath = `/workers/scripts/${config.prefix}-gateway/schedules`;
  try { await request(config, token, 'PUT', schedulePath, []); } catch { /* Continue with all queues. */ }
  for (const saved of state.original.queues) {
    try {
      const live = queue(await request(config, token, 'GET', `/queues/${saved.id}`), saved.name);
      if (live.id !== saved.id) throw new Error();
      // Preserve current non-delivery settings, and retain the original
      // snapshot unchanged for a later deliberate resume.
      await request(config, token, 'PUT', `/queues/${saved.id}`, {
        queue_name: saved.name, settings: { ...live.settings, delivery_paused: true },
      });
    } catch { /* Continue; read back every queue independently below. */ }
  }
  const uncertainBackground = [];
  try {
    if (schedules(await request(config, token, 'GET', schedulePath)).length !== 0) uncertainBackground.push('gateway cron');
  } catch { uncertainBackground.push('gateway cron'); }
  for (const saved of state.original.queues) {
    try {
      const live = queue(await request(config, token, 'GET', `/queues/${saved.id}`), saved.name);
      if (live.id !== saved.id || live.settings.delivery_paused !== true) uncertainBackground.push(saved.name);
    } catch { uncertainBackground.push(saved.name); }
  }
  let gatewayPaused = false;
  try { gatewayPaused = await probe(config); } catch { /* Report uncertainty explicitly. */ }
  const paused = gatewayPaused && uncertainBackground.length === 0;
  state.phase = paused ? 'paused' : 'resuming';
  state.updatedAt = new Date().toISOString();
  let stateSaved = false;
  try { await save(state); stateSaved = true; } catch { /* Previous original snapshot remains retained. */ }
  if (paused && stateSaved)
    fail('Resume failed. Gateway maintenance, empty cron, and all event queues paused are verified. Original restoration state is retained; resolve the issue and rerun resume.');
  const details = [gatewayPaused ? 'Gateway maintenance is verified.' : 'Public ingress maintenance is uncertain.'];
  if (uncertainBackground.length) details.push(`Background controls remain uncertain: ${uncertainBackground.join(', ')}.`);
  else details.push('Empty cron and all event queues paused are verified.');
  if (!stateSaved) details.push('Updated recovery phase could not be saved; preserve the original snapshot.');
  fail(`Resume failed. ${details.join(' ')} Reconfirm maintenance and background controls before further work.`);
}
export async function main(argv = process.argv.slice(2)) {
  const [command, ...extra] = argv;
  if (!['status', 'pause', 'resume'].includes(command) || extra.length) fail('Usage: node scripts/cloudflare-maintenance.mjs status|pause|resume');
  let config;
  try {
    config = validateDeployment(JSON.parse(await readFile(join(root, '.cloudflare', 'deployment.json'), 'utf8')), true);
    const generated = JSON.parse(await readFile(configPath, 'utf8'));
    if (generated.name !== `${config.prefix}-gateway` || generated.account_id !== config.accountId || generated.vars?.TUTS_MAINTENANCE !== undefined) throw new Error();
  } catch { fail('Valid deployment and matching generated gateway config without a conflicting maintenance variable are required.'); }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Recovery directory must be a real directory.');
  await chmod(directory, 0o700);
  const lockPath = join(directory, 'maintenance.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { fail('Another maintenance command may be active. Review the private lock file before retrying.'); }
  try {
    await lock.writeFile(`${process.pid}\n`);
    const token = await credentials(config);
    let state = await load(config);
    let current = await controls(config, token, state?.original);
    const maintenance = await probe(config);
    if (state?.phase === 'resumed' && state.original.queues.length !== consumers.length) {
      if (maintenance || !equal(current.schedules, state.original.schedules)) fail('Prior maintenance state changed; cannot expand its queue topology.');
      for (const saved of state.original.queues) {
        if (!equal(current.queues.find(item => item.name === saved.name), saved)) fail('An existing event queue changed; preserve the prior maintenance snapshot.');
      }
      if (current.queues.filter(item => !state.original.queues.some(saved => saved.name === item.name)).some(item => item.settings.delivery_paused)) fail('A new event queue is paused; review its restoration state.');
      if (command !== 'status') {
        await rename(statePath, join(directory, `maintenance-completed-${Date.now()}.json`));
        state = undefined;
      }
    }
    if (command === 'status') {
      console.log(JSON.stringify({ maintenance, phase: state?.phase ?? 'unmanaged', cronCount: current.schedules.length,
        queues: current.queues.map(item => ({ name: item.name, deliveryPaused: item.settings.delivery_paused })) }));
      return;
    }
    if (command === 'pause' && (!state || state.phase === 'resumed')) {
      if (maintenance) fail('Gateway is already in maintenance without an active restoration snapshot; preserve existing controls and review.');
      if (state && !equal(current, state.original)) fail('Resumed deployment controls changed unexpectedly; preserve prior state and review.');
      state = { version: 1, accountId: config.accountId, prefix: config.prefix, publicUrl: config.publicUrl,
        phase: 'pausing', capturedAt: new Date().toISOString(), original: current };
      await save(state); // Capture restoration data durably before any cloud mutation.
    }
    if (!state) fail('No saved maintenance snapshot exists; resume is unsafe.');
    validateCurrent(current, state);
    if (command === 'pause' && state.phase === 'resuming') fail('A resume is incomplete; rerun resume before starting another pause.');
    if (command === 'resume' && state.phase === 'resumed') {
      if (maintenance || !equal(current, state.original)) fail('Previously resumed state changed unexpectedly; review before reopening.');
      console.log(JSON.stringify({ maintenance: false, phase: 'resumed' }));
      return;
    }
    state.phase = command === 'pause' ? 'pausing' : 'resuming';
    await save(state);
    const complete = async () => {
      // Reassert first even on retry, so incomplete operations never open ingress.
      await setMaintenance(config, token, true);
      current = await controls(config, token, state.original);
      validateCurrent(current, state);
      const target = command === 'pause' ? { schedules: [], queues: state.original.queues.map(item =>
        ({ ...item, settings: { ...item.settings, delivery_paused: true } })) } : state.original;
      await setControls(config, token, current, target);
      if (command === 'resume') await setMaintenance(config, token, false);
      state.phase = command === 'pause' ? 'paused' : 'resumed';
      state.updatedAt = new Date().toISOString();
      await save(state);
    };
    if (command === 'resume') {
      // Enclose control restoration and reopening together: failures at any
      // stage must close ingress AND pause cron and every queue again.
      try { await complete(); }
      catch { await pauseAfterResumeFailure(config, token, state); }
    } else await complete();
    console.log(JSON.stringify({ maintenance: command === 'pause', phase: state.phase }));
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
