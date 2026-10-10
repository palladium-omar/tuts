import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createBackup,extractBackup,materializeR2Objects } from '../encrypted-backup.mjs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { Database } from '../../packages/service-kit/dist/database.js';
import { serviceNames, root } from '../cloudflare.mjs';
import { metadata } from '../snapshot-hosted-data.mjs';
import { validateTarget, digest, qi, loadSnapshot, tableOrder, restoreSnapshot } from '../restore-hosted-snapshot.mjs';

test('restore target refuses hosted URLs, live names and maintenance database substitution', () => {
  const manifest = { services:{platform:{database:'restore_demo_platform'}} };
  for (const url of ['postgres://admin@neon.example/postgres','postgres://admin@127.0.0.1/platform','postgres://admin@127.0.0.1/postgres?host=neon.example']) {
    // URI query host overrides are rejected below too.
    assert.throws(()=>validateTarget(url,'restore_demo',manifest));
  }
  assert.throws(()=>validateTarget('postgres://admin@localhost/postgres','tuts',manifest));
  assert.equal(validateTarget('postgres://admin@127.0.0.1/postgres','restore_test',{services:{}}).targets.length,10);
});
test('FK ordering handles dependencies and cycles with deferred constraint reinstall', () => {
  assert.deepEqual(tableOrder(['child','parent'],[{child:'child',parent:'parent'}]),['parent','child']);
  assert.deepEqual(tableOrder(['a','b'],[{child:'a',parent:'b'},{child:'b',parent:'a'}]),['a','b']);
});

test('ten-service isolated roundtrip preserves raw bigint JSON, FKs, RLS and migration inventories', async () => {
  // Require explicit opt-in: these tests create and remove only uniquely named
  // new local synthetic databases, never the existing service databases.
  assert.equal(process.env.RECOVERY_TEST_LOCAL, '1', 'Run with RECOVERY_TEST_LOCAL=1 for mandatory local PostgreSQL roundtrip');
  const env = parseEnv(await readFile(join(root,'.env'),'utf8'));
  const adminUrl = new URL('postgresql://postgres@127.0.0.1:5434/postgres');
  adminUrl.password = env.POSTGRES_PASSWORD;
  const admin = new pg.Client({connectionString:adminUrl.toString()});
  await admin.connect();
  const stamp = `${Date.now()}_${process.pid}`;
  const sourcePrefix = `restore_src_${stamp}`, targetPrefix = `restore_dst_${stamp}`;
  const created = [], directory = await mkdtemp(join(tmpdir(),'tuts-recovery-')), backupDirectory=await mkdtemp(join(tmpdir(),'tuts-complete-recovery-'));
  try {
    const manifest = {version:1,format:'jsonl-lossless',createdAt:new Date().toISOString(),services:{}};
    for (const service of serviceNames) {
      const database = `${sourcePrefix}_${service}`;
      await admin.query(`CREATE DATABASE ${qi(database)} TEMPLATE template0`); created.push(database);
      const url = new URL(adminUrl);url.pathname=`/${database}`;
      process.env.DATABASE_URL=url.toString();delete process.env.TUTS_RUNTIME;
      const db = new Database();
      try { await db.migrate(join(root,'services',service,'migrations')); }
      finally { await db.pool.end(); }
      const client = new pg.Client({connectionString:url.toString()});await client.connect();
      try {
        await client.query(`INSERT INTO service_outbox(id,event) VALUES('11111111-1111-4111-8111-111111111111','{"data":{"large":9007199254740993},"businessId":"22222222-2222-4222-8222-222222222222"}'::jsonb)`);
        await client.query(`INSERT INTO service_inbox(consumer,event_id) VALUES($1,'11111111-1111-4111-8111-111111111111')`,[service]);
        await client.query(`INSERT INTO service_request_budgets(scope,window_start,used) VALUES('synthetic',date_trunc('minute',now()),2)`);
        const fixtureSql = `CREATE SEQUENCE recovery_fixture_seq START 10 INCREMENT 3;
          CREATE TABLE recovery_fixture (id bigint PRIMARY KEY DEFAULT nextval('recovery_fixture_seq'), parent_id bigint REFERENCES recovery_fixture(id), amount numeric(30,0) NOT NULL);
          INSERT INTO recovery_fixture(id,parent_id,amount) VALUES (9007199254740993,9007199254740995,9007199254740997),(9007199254740995,9007199254740993,9007199254740999);`;
        // Only DDL belongs in migrations; fixture rows belong in JSONL.
        const migrationSql = fixtureSql.split('INSERT INTO')[0];
        await client.query(fixtureSql);
        await client.query("SELECT nextval('recovery_fixture_seq')");
        await client.query("INSERT INTO service_migrations(name) VALUES('999_recovery_fixture.sql')");
        const catalog = await metadata(client);catalog.roles=[];
        catalog.sequences=(await client.query("SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value::text FROM pg_sequences WHERE schemaname='public'")).rows;
        for(const sequence of catalog.sequences) Object.assign(sequence,(await client.query(`SELECT last_value::text,is_called FROM public.${qi(sequence.sequencename)}`)).rows[0]);
        const base=join(directory,service);await mkdir(join(base,'migrations'),{recursive:true,mode:0o700});
        const catalogRaw=JSON.stringify(catalog,null,2);await writeFile(join(base,'catalog.json'),catalogRaw,{mode:0o600});
        const tables={};
        for (const table of catalog.tables.map(JSON.parse)) {
          const rows=(await client.query(`SELECT to_jsonb(t)::text json FROM public.${qi(table.name)} t`)).rows.map(r=>r.json).sort();
          const data=rows.map(row=>row+'\n').join(''),file=`table-${Object.keys(tables).length}.jsonl`;
          await writeFile(join(base,file),data,{mode:0o600});tables[table.name]={file,rows:rows.length,sha256:digest(data)};
        }
        const migrations=[];
        for (const name of (await readdir(join(root,'services',service,'migrations'))).filter(n=>n.endsWith('.sql')).sort()) {
          const sql=await readFile(join(root,'services',service,'migrations',name));await writeFile(join(base,'migrations',name),sql,{mode:0o600});migrations.push({name,sha256:digest(sql)});
        }
        await writeFile(join(base,'migrations','999_recovery_fixture.sql'),migrationSql,{mode:0o600});
        migrations.push({name:'999_recovery_fixture.sql',sha256:digest(migrationSql)});
        manifest.services[service]={database,tables,migrations,catalogSha256:digest(catalogRaw)};
      } finally {await client.end();}
    }
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});await writeFile(join(directory,'COMPLETE'),'synthetic');
    const validated=await loadSnapshot(directory);assert.equal(Object.keys(validated.services).length,10);
    // Exercise the actual encrypted SQL+private key/config+R2 handoff before
    // restoring all ten schemas from the authenticated extracted archive.
    const backupKey=join(backupDirectory,'key'),config=join(backupDirectory,'config'),ciphertext=join(backupDirectory,'complete.tuts-backup'),extracted=join(backupDirectory,'extracted');
    await mkdir(config,{mode:0o700});await writeFile(backupKey,randomBytes(32),{mode:0o600});
    await writeFile(join(config,'deployment.json'),JSON.stringify({prefix:'synthetic',accountId:'a'.repeat(32)}));
    await writeFile(join(config,'secrets.json'),JSON.stringify({CONTEXT_PRIVATE_KEY:'synthetic-private-recovery-key'}));
    const resourceKey='11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
    const storage={async list(bucket){return bucket.endsWith('-uploads')?[{key:resourceKey,etag:'synthetic',size:4}]:[];},async get(){return Readable.from([Buffer.from([0,255,34,0])]);}};
    await createBackup({snapshotDirectory:directory,keyFile:backupKey,outputFile:ciphertext,configDirectory:config,r2Client:storage,frozen:true,freezeStartedAt:manifest.createdAt});
    await extractBackup({backupFile:ciphertext,keyFile:backupKey,targetDirectory:extracted});
    const localStorage=join(backupDirectory,'storage');assert.equal((await materializeR2Objects({extractedDirectory:extracted,targetDirectory:localStorage})).objects,1);
    assert.deepEqual(await readFile(join(localStorage,'uploads',resourceKey)),Buffer.from([0,255,34,0]));
    assert.equal(JSON.parse(await readFile(join(extracted,'private/secrets.json'))).CONTEXT_PRIVATE_KEY,'synthetic-private-recovery-key');
    const receipt=await restoreSnapshot({directory:join(extracted,'snapshot'),adminUrl:adminUrl.toString(),prefix:targetPrefix});
    console.log(`Synthetic ten-service isolated restore verified in ${receipt.durationMs} ms; hosted recovery time remains unmeasured.`);
    created.push(...receipt.isolatedDatabases);assert.equal(Object.keys(receipt.services).length,10);
    assert.ok(Object.values(receipt.services).every(result=>result.verified));
    await assert.rejects(restoreSnapshot({directory,adminUrl:adminUrl.toString(),prefix:targetPrefix}),/existing targets/);
    // Integrity, traversal and incomplete inventory all fail before DB creation.
    const original=manifest.services.platform.tables.service_outbox.file;
    manifest.services.platform.tables.service_outbox.file='../outside.jsonl';
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
    await assert.rejects(loadSnapshot(directory),/Unsafe table archive/);
    manifest.services.platform.tables.service_outbox.file=original;
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
    await writeFile(join(directory,'platform',original),'{}\n');
    await assert.rejects(loadSnapshot(directory),/integrity/);
  } finally {
    // Failed restores preserve targets for humans; synthetic tests deliberately
    // remove only their own generated names, including partial failed targets.
    const leftovers=await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname LIKE $2',[`${sourcePrefix}_%`,`${targetPrefix}_%`]);
    for (const {datname} of leftovers.rows) {assert.ok(datname.startsWith(sourcePrefix)||datname.startsWith(targetPrefix));await admin.query(`DROP DATABASE ${qi(datname)}`);}
    await admin.end();await rm(directory,{recursive:true,force:true});await rm(backupDirectory,{recursive:true,force:true});
  }
});
