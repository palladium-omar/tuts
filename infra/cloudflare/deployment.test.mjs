import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { eventConsumerSubscriptions } from '../../packages/contracts/dist/index.js';
import { createConfigs, freshSecrets, serviceNames, secretsFor, validateDeployment, databaseUrl, sqlName, deployOrder, validateServiceDatabaseUrls, verifyRole } from '../../scripts/cloudflare.mjs';
const deployment = { prefix: 'tuts', accountId: 'a'.repeat(32), publicUrl: 'https://tuts-gateway.synthetic.workers.dev' };

test('manifest requires a secure canonical URL and valid account/resource identity', () => {
  assert.equal(validateDeployment(deployment).publicUrl, deployment.publicUrl);
  for (const publicUrl of ['http://example.com', 'https://name:secret@example.com', 'https://example.com/path', 'https://gateway.example.com'])
    assert.throws(() => validateDeployment({ ...deployment, publicUrl }));
  assert.throws(() => validateDeployment({ ...deployment, accountId: '' }, true));
  assert.throws(() => validateDeployment({ ...deployment, customDomain: 'tuts.example.com' }));
  assert.equal(validateDeployment({ ...deployment, publicUrl: 'https://tuts.example.com', customDomain: 'tuts.example.com' }).customDomain, 'tuts.example.com');
});
test('all eight domains remain private with minimal bindings and no credentials in config', () => {
  const configs = createConfigs(deployment, eventConsumerSubscriptions, '/synthetic/repo');
  assert.equal(Object.keys(configs).length, 9);
  for (const name of serviceNames) {
    const config = configs[name];
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.main, `/synthetic/repo/services/${name}/dist/worker.js`);
    assert.equal(config.vars.ALLOW_OUTBOUND_DELIVERY, 'false');
    assert.equal(config.vars.ALLOW_SANDBOX_PAYMENTS, 'false');
    assert.equal(config.triggers, undefined);
    assert.equal(Object.keys(config.vars).some(key => /SECRET|KEY|PASSWORD|DATABASE_URL/.test(key)), false);
    assert.deepEqual(config.r2_buckets.find(bucket => bucket.binding === 'EVENT_PAYLOADS'), { binding: 'EVENT_PAYLOADS', bucket_name: 'tuts-event-payloads' });
    assert.equal(config.r2_buckets.some(bucket => bucket.binding === 'UPLOADS'), name === 'learning');
    assert.equal(config.r2_buckets.length, name === 'learning' ? 2 : 1);
  }
  assert.deepEqual(configs.billing.services, [{ binding: 'SCHEDULING', service: 'tuts-scheduling' }]);
  assert.deepEqual(configs.notifications.services, [{ binding: 'CLIENTS', service: 'tuts-clients' }]);
  for (const name of serviceNames.filter(name => !['billing', 'notifications'].includes(name))) assert.equal(configs[name].services, undefined);
  assert.equal(configs.gateway.workers_dev, true);
  assert.equal(configs.gateway.services.length, 8);
  assert.deepEqual(configs.gateway.triggers.crons, ['*/15 * * * *']);
  assert.equal(configs.gateway.assets.binding, 'ASSETS');
  assert.equal(configs.gateway.r2_buckets, undefined);
});
test('queue fanout is generated from contract producer prefixes with six consumers and dead letters', () => {
  const configs = createConfigs(deployment, eventConsumerSubscriptions);
  let consumers = 0;
  for (const name of serviceNames) {
    const config = configs[name];
    const expected = eventConsumerSubscriptions.filter(subscription => subscription.types.some(type => type.startsWith(`${name}.`))).map(subscription => `EVENTS_${subscription.consumer.toUpperCase()}`);
    assert.deepEqual(config.queues.producers?.map(producer => producer.binding) ?? [], expected);
    if (config.queues.consumers) {
      consumers++;
      assert.equal(config.queues.consumers[0].max_retries, 5);
      assert.equal(config.queues.consumers[0].dead_letter_queue, `tuts-events-${name}-dead`);
    }
  }
  assert.equal(consumers, 6);
});
test('secrets are fresh once, preserved on rerun, and scoped to each worker', () => {
  const first = freshSecrets();
  assert.equal(createPublicKey(first.CONTEXT_PRIVATE_KEY).export({ type: 'spki', format: 'pem' }), first.CONTEXT_PUBLIC_KEY);
  assert.deepEqual(freshSecrets(first), first);
  assert.equal(Object.keys(first.databasePasswords).length, 8);
  const secretValues = Object.values(first.databasePasswords);
  assert.equal(new Set(secretValues).size, 8);
  assert.equal(first.INTERNAL_RUNTIME_SECRET.length >= 32, true);
  for (const name of serviceNames) first.databaseUrls[name] = `postgresql://tuts_${name}:synthetic@db.example.com/tuts_${name}?sslmode=require`;
  for (const name of serviceNames) {
    const value = secretsFor(name, first);
    assert.equal(value.DATABASE_URL, first.databaseUrls[name]);
    assert.equal(value.CONTEXT_PRIVATE_KEY, undefined);
    assert.equal(value.adminDatabaseUrl, undefined);
    assert.equal(value.databasePasswords, undefined);
    assert.equal(Boolean(value.BETTER_AUTH_SECRET), name === 'platform');
    assert.equal(Boolean(value.PAYMENT_ENCRYPTION_KEY), name === 'payments');
  }
  assert.deepEqual(Object.keys(secretsFor('gateway', first)).sort(), ['CONTEXT_PRIVATE_KEY', 'INTERNAL_RUNTIME_SECRET', 'PLATFORM_INTERNAL_SECRET']);
  assert.throws(() => freshSecrets({ CONTEXT_PUBLIC_KEY: first.CONTEXT_PUBLIC_KEY }));
});
test('database URLs select isolated SQL roles/databases and require TLS', () => {
  const value = new URL(databaseUrl('postgresql://admin:private@db.example.com/neondb?sslmode=require', deployment, 'learning', 'synthetic'));
  assert.equal(value.username, 'tuts_learning');
  assert.equal(value.pathname, '/tuts_learning');
  assert.equal(value.searchParams.get('sslmode'), 'require');
  assert.equal(sqlName({ ...deployment, prefix: 'tuts-prod' }, 'learning'), 'tuts_prod_learning');
  assert.throws(() => databaseUrl('http://admin.example.com', deployment, 'learning', 'synthetic'));
});
test('service binding targets deploy before callers and public gateway deploys last', () => {
  assert.ok(deployOrder.indexOf('scheduling') < deployOrder.indexOf('billing'));
  assert.ok(deployOrder.indexOf('clients') < deployOrder.indexOf('notifications'));
  assert.equal(deployOrder.at(-1), 'gateway');
  assert.equal(new Set(deployOrder).size, 9);
});

test('deployment refuses cross-service database credentials and insecure URLs', () => {
  const secrets = freshSecrets();
  for (const name of serviceNames) secrets.databaseUrls[name] = databaseUrl('postgresql://admin:private@db.example.com/neondb?sslmode=require', deployment, name, secrets.databasePasswords[name]);
  validateServiceDatabaseUrls(deployment, secrets);
  const previous = secrets.databaseUrls.learning;
  secrets.databaseUrls.learning = secrets.databaseUrls.clients;
  assert.throws(() => validateServiceDatabaseUrls(deployment, secrets), /own ordinary SQL role/);
  secrets.databaseUrls.learning = previous.replace('sslmode=require', 'sslmode=disable');
  assert.throws(() => validateServiceDatabaseUrls(deployment, secrets), /require TLS/);
});
test('existing roles fail closed on RLS bypass or inherited/admin privileges', async () => {
  const ordinary = { rolname: 'tuts_learning', rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false };
  const client = row => ({ async query(sql) { return sql.includes('pg_auth_members') ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 }; } });
  await verifyRole(client(ordinary), 'tuts_learning');
  for (const field of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication'])
    await assert.rejects(verifyRole(client({ ...ordinary, [field]: true }), 'tuts_learning'), /Unsafe database privileges/);
  await assert.rejects(verifyRole({ async query(sql) { return sql.includes('pg_auth_members') ? { rows: [{ rolname: 'neon_superuser' }], rowCount: 1 } : { rows: [ordinary], rowCount: 1 }; } }, 'tuts_learning'), /inherited role memberships/);
});

test('dedicated event payload lifecycle outlives queue retention and expires private objects', async () => {
  const { readFile } = await import('node:fs/promises');
  const policy = JSON.parse(await readFile(new URL('./event-payload-lifecycle.json', import.meta.url), 'utf8'));
  assert.deepEqual(policy.rules, [{ id: 'event-payload-expiration', enabled: true, conditions: { prefix: '' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 7 * 86400 } } }]);
  assert.ok(policy.rules[0].deleteObjectsTransition.condition.maxAge > 86400);
});
