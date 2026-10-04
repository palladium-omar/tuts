#!/usr/bin/env node
// Administrative issuance uses BetterAuth's native token generation/storage.
// It creates no password and delivers nothing; the operator handles the file.
import { createRequire } from 'node:module';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const platformRequire = createRequire(join(root, 'services/platform/package.json'));
await import(platformRequire.resolve('reflect-metadata'));
const { betterAuth } = await import(platformRequire.resolve('better-auth'));
const { IdentityService } = await import('../services/platform/dist/identity.service.js');

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('Usage: node scripts/issue-password-reset.mjs EMAIL [--delivery-file PRIVATE_PATH]');
    return;
  }
  const email = args[0];
  if (!email || email.startsWith('-') || (args.length !== 1 && (args.length !== 3 || args[1] !== '--delivery-file'))) {
    throw new Error('Invalid arguments');
  }
  const privateDirectory = join(root, '.cloudflare/auth-mail');
  const deliveryFile = args[2]
    ? resolve(args[2])
    : join(privateDirectory, `password-reset-${randomUUID()}.json`);
  const secrets = JSON.parse(await readFile(join(root, '.cloudflare/secrets.json'), 'utf8'));
  const deployment = JSON.parse(await readFile(join(root, '.cloudflare/deployment.json'), 'utf8'));
  const origin = new URL(deployment.publicUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('A configured HTTPS public app origin is required');
  }
  const databaseUrl = new URL(secrets.databaseUrls?.platform);
  const platformRole = `${(deployment.prefix || 'tuts').replace(/-/g, '_')}_platform`;
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
      decodeURIComponent(databaseUrl.username) !== platformRole ||
      decodeURIComponent(databaseUrl.pathname.slice(1)) !== platformRole) {
    throw new Error('Only the configured platform database and role may issue recovery tokens');
  }
  databaseUrl.searchParams.set('sslmode', 'verify-full');
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_APP_URL = origin.origin;
  process.env.PUBLIC_GATEWAY_URL = origin.origin;
  process.env.BETTER_AUTH_SECRET = secrets.BETTER_AUTH_SECRET;
  process.env.PLATFORM_INTERNAL_SECRET = secrets.PLATFORM_INTERNAL_SECRET;

  const pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    connectionTimeoutMillis: 15_000,
    ssl: { rejectUnauthorized: true, checkServerIdentity },
    max: 1,
  });
  pool.on('error', () => {});
  try {
    const role = (await pool.query(`SELECT current_user AS name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!role?.rolcanlogin || role.name !== platformRole ||
        ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication'].some(key => role[key]) ||
        (await pool.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rowCount) {
      throw new Error('Password recovery requires an isolated ordinary platform database role');
    }
    await mkdir(dirname(deliveryFile), { recursive: true, mode: 0o700 });
    // Reserve an exclusive 0600 file before token issuance; no symlink following
    // or accidental overwrite of an existing recovery link is possible.
    const output = await open(deliveryFile, 'wx', 0o600);
    let delivered = false;
    try {
      const identity = new IdentityService({ pool });
      const auth = betterAuth({
        ...identity.auth.options,
        // Administrative issuance must finish saving the private file before
        // this short-lived process closes its file and database connection.
        advanced: { ...identity.auth.options.advanced, backgroundTasks: undefined },
        emailAndPassword: {
          ...identity.auth.options.emailAndPassword,
          sendResetPassword: async ({ user, token }) => {
            const resetUrl = new URL('/reset-password', origin.origin);
            resetUrl.hash = `token=${encodeURIComponent(token)}`;
            await output.writeFile(`${JSON.stringify({
              recipientEmail: user.email,
              resetUrl: resetUrl.toString(),
              expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            }, null, 2)}\n`);
            await output.sync();
            delivered = true;
          },
        },
      });
      await auth.api.requestPasswordReset({ body: { email } });
      if (!delivered) throw new Error('No recovery link was saved; verify the address and private file permissions');
    } finally {
      await output.close();
    }
    console.log(`Password recovery link saved in private file: ${deliveryFile}`);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // Provider/driver exceptions can include credentials or connection URLs.
  console.error('Password recovery issuance failed. Check the configured platform role, public origin, account address and private output file.');
  process.exitCode = 1;
});
