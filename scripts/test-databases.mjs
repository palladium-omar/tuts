// Ordinary local roles only. Never connects to hosted production databases.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skipDetector } from './test-output.mjs';
import { Database } from '../packages/service-kit/dist/index.js';
const root = new URL('../', import.meta.url);
const config = parseEnv(await readFile(new URL('.env', root), 'utf8'));
const names = ['platform','clients','scheduling','learning','billing','payments','notifications','integrations','planning','reporting'];
let failed = false;
for (const name of names) {
  const manifest=JSON.parse(await readFile(new URL(`services/${name}/package.json`,root),'utf8'));
  if(typeof manifest.scripts?.test!=='string' || !manifest.scripts.test.trim()) {
    process.stderr.write(`Missing required database test script for ${name}\n`);failed=true;continue;
  }
  const password = config[`${name.toUpperCase()}_DB_PASSWORD`];
  if (!password) throw new Error(`Missing local database password for ${name}; run setup:local`);
  const url = `postgresql://${name}:${encodeURIComponent(password)}@127.0.0.1:5434/${name}`;
  process.env.DATABASE_URL = url;
  const db = new Database();
  try {
    const role = (await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (role.rolsuper || role.rolbypassrls) throw new Error('Tests require ordinary roles');
    await db.migrate(fileURLToPath(new URL(`services/${name}/migrations`, root)));
  } finally { await db.pool.end(); }
  const env = { ...process.env, ...config, DATABASE_URL:url, [`${name.toUpperCase()}_TEST_DATABASE_URL`]:url, DISABLE_BROKER:'true', AUTH_MAIL_ENABLED:'false' };
  const code = await new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', `@palladium/${name}`, 'test'], {cwd:fileURLToPath(root),env,stdio:['ignore','pipe','pipe']});
    const detector = skipDetector();
    child.stdout.on('data', chunk => { const value=chunk.toString(); detector.observe(value); process.stdout.write(value); });
    child.stderr.on('data', chunk => {const value=chunk.toString();detector.observe(value, 'stderr');process.stderr.write(value);});
    child.on('error', reject); child.on('close', code => resolve(code === 0 && !detector.hasSkipped() ? 0 : 1));
  });
  if (code) failed=true;
}
if (failed) process.exitCode=1;
