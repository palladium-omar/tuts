import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,stat,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { serviceNames } from '../cloudflare.mjs';
import { digest } from '../restore-hosted-snapshot.mjs';
import { createBackup,extractBackup,verifyBackup,r2ReadClient,retentionReport,materializeR2Objects } from '../encrypted-backup.mjs';
async function fixture(){
  const base=await mkdtemp(join(tmpdir(),'tuts-encrypted-test-')),snapshot=join(base,'snapshot'),config=join(base,'config'),key=join(base,'backup-key');
  await mkdir(snapshot,{mode:0o700});await mkdir(config,{mode:0o700});await writeFile(key,randomBytes(32),{mode:0o600});
  const manifest={version:1,format:'jsonl-lossless',createdAt:new Date().toISOString(),services:{}};
  for(const service of serviceNames){
    const directory=join(snapshot,service);await mkdir(directory);await mkdir(join(directory,'migrations'));
    const catalog=JSON.stringify({tables:[JSON.stringify({name:'service_migrations',rls:false,force_rls:false})],columns:[],constraints:[],indexes:[],policies:[],triggers:[],functions:[],extensions:[],sequences:[],roles:[]},null,2);
    await writeFile(join(directory,'catalog.json'),catalog);await writeFile(join(directory,'table-0.jsonl'),'');
    manifest.services[service]={database:service,tables:{service_migrations:{file:'table-0.jsonl',rows:0,sha256:digest('')}},migrations:[],catalogSha256:digest(catalog)};
  }
  await writeFile(join(snapshot,'manifest.json'),JSON.stringify(manifest));await writeFile(join(snapshot,'COMPLETE'),'synthetic');
  await writeFile(join(config,'deployment.json'),JSON.stringify({prefix:'synthetic',accountId:'0'.repeat(32)}));await writeFile(join(config,'secrets.json'),JSON.stringify({CONTEXT_PRIVATE_KEY:'private-test-sentinel',INTEGRATIONS_ENCRYPTION_KEY:'key-test-sentinel'}));
  const object={key:'../../private/escape.bin',etag:'abc123',size:4,last_modified:new Date().toISOString(),custom_metadata:{purpose:'synthetic'}};
  const r2Client={async list(bucket){return bucket.endsWith('uploads')?[object]:[];},async get(){return Readable.from([Buffer.from([0,255,34,0])]);}};
  const options={snapshotDirectory:snapshot,keyFile:key,outputFile:join(base,'complete.tuts-backup'),configDirectory:config,r2Client,frozen:true,freezeStartedAt:new Date(Date.now()-1000).toISOString()};
  return {base,snapshot,config,key,options};
}
test('encrypted SQL/config/R2 backup is authenticated, private and recoverable without provider writes',async()=>{
  const f=await fixture();try{
    const receipt=await createBackup(f.options);assert.equal(receipt.r2Objects,1);assert.equal(receipt.authenticated,true);
    const encrypted=await readFile(f.options.outputFile);assert.equal(encrypted.includes(Buffer.from('private-test-sentinel')),false);assert.equal(encrypted.includes(Buffer.from('key-test-sentinel')),false);assert.equal((await stat(f.options.outputFile)).mode&0o077,0);
    const target=join(f.base,'new-extracted');await extractBackup({backupFile:f.options.outputFile,keyFile:f.key,targetDirectory:target});
    assert.deepEqual(await readFile(join(target,'r2/objects/0.bin')),Buffer.from([0,255,34,0]));assert.equal(JSON.parse(await readFile(join(target,'private/secrets.json'))).CONTEXT_PRIVATE_KEY,'private-test-sentinel');
    await assert.rejects(materializeR2Objects({extractedDirectory:target,targetDirectory:join(f.base,'unsafe-storage')}),/outside known/);
    await assert.rejects(stat(join(f.base,'unsafe-storage')),e=>e.code==='ENOENT');
    await assert.rejects(extractBackup({backupFile:f.options.outputFile,keyFile:f.key,targetDirectory:target}));
    await assert.rejects(createBackup(f.options)); // Existing ciphertext must never be replaced.
    const before=await readFile(f.options.outputFile);assert.deepEqual(before,encrypted);
    const changed=Buffer.from(encrypted);changed[changed.length-20]^=1;const corrupt=join(f.base,'corrupt.tuts-backup');await writeFile(corrupt,changed);
    const failedTarget=join(f.base,'no-plaintext');await assert.rejects(extractBackup({backupFile:corrupt,keyFile:f.key,targetDirectory:failedTarget}),/authentication failed/);await assert.rejects(stat(failedTarget),e=>e.code==='ENOENT');
    const wrong=join(f.base,'wrong-key');await writeFile(wrong,randomBytes(32),{mode:0o600});await assert.rejects(verifyBackup({backupFile:f.options.outputFile,keyFile:wrong}),/authentication failed/);
    assert.ok((await readdir(f.base)).every(name=>!name.startsWith('.tuts-extract-')&&!name.startsWith('.tuts-backup-')));
  }finally{await rm(f.base,{recursive:true,force:true});}
});
test('capture fails closed on budgets, stale snapshots and changed R2 inventory',async()=>{
  const f=await fixture();try{
    await assert.rejects(createBackup({...f.options,maxTotalBytes:1}),/resource budget/);
    await assert.rejects(createBackup({...f.options,frozen:false}),/Pause writers/);
    await assert.rejects(createBackup({...f.options,freezeStartedAt:new Date(Date.now()+1000).toISOString()}),/current coordinated window/);
    let calls=0;const bad={...f.options.r2Client,async list(bucket){calls++;return bucket.endsWith('uploads')?(calls>2?[]:[{key:'one',etag:'abc',size:4}]):[];}};
    await assert.rejects(createBackup({...f.options,r2Client:bad}),/inventory changed/);await assert.rejects(stat(f.options.outputFile),e=>e.code==='ENOENT');
    assert.ok((await readdir(f.base)).every(name=>!name.endsWith('.partial')));
  }finally{await rm(f.base,{recursive:true,force:true});}
});
test('R2 reads paginate safely without logging object keys or retrying incomplete inventory',async()=>{
  let calls=0;const client=r2ReadClient({accountId:'a'.repeat(32),token:'synthetic-token',async request(url,init){assert.equal(init.headers.authorization,'Bearer synthetic-token');assert.equal(init.redirect,'error');calls++;return Response.json({success:true,result:[{key:`key${calls}`,etag:'abc',size:1}],result_info:calls===1?{is_truncated:true,cursor:'next'}:{is_truncated:false}});}});
  assert.equal((await client.list('synthetic')).length,2);assert.equal(calls,2);
  const bad=r2ReadClient({accountId:'a'.repeat(32),token:'synthetic',async request(){return Response.json({success:true,result:[],result_info:{is_truncated:true}});}});await assert.rejects(bad.list('synthetic'),/pagination/);
});
test('retention reports complete older encrypted copies but never deletes or selects unverified data',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tuts-retention-'));try{
    for(let i=0;i<9;i++){const name=`backup-${i}.tuts-backup`;await writeFile(join(directory,name),'ciphertext');await writeFile(join(directory,`${name}.receipt.json`),JSON.stringify({authenticated:true,encryptedBytes:10,createdAt:new Date(Date.now()-(i+40)*86400000).toISOString()}));}
    await writeFile(join(directory,'incomplete.tuts-backup'),'incomplete');const report=await retentionReport(directory);assert.equal(report.length,9);assert.equal(report.filter(f=>f.action==='review_expiration').length,2);assert.ok(report.every(f=>f.deleted===false));assert.equal((await readdir(directory)).length,19);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('known private R2 layouts materialize losslessly in new local storage',async()=>{
  const f=await fixture();try{
    const business='11111111-1111-4111-8111-111111111111',key='22222222-2222-4222-8222-222222222222';
    const client={async list(bucket){return [{key:bucket.endsWith('-uploads')?`${business}/${key}`:`v1/learning/${business}/${key}.json`,etag:'abc123',size:4}];},async get(){return Readable.from([Buffer.from([0,255,34,0])]);}};
    await createBackup({...f.options,r2Client:client});
    const extracted=join(f.base,'extracted'),storage=join(f.base,'local-storage');
    await extractBackup({backupFile:f.options.outputFile,keyFile:f.key,targetDirectory:extracted});
    const result=await materializeR2Objects({extractedDirectory:extracted,targetDirectory:storage});assert.equal(result.objects,2);assert.equal(result.remoteWrites,false);
    assert.deepEqual(await readFile(join(storage,'uploads',business,key)),Buffer.from([0,255,34,0]));
    assert.deepEqual(await readFile(join(storage,'event-payloads/v1/learning',business,`${key}.json`)),Buffer.from([0,255,34,0]));
    await assert.rejects(materializeR2Objects({extractedDirectory:extracted,targetDirectory:storage}));
    await writeFile(join(extracted,'r2/objects/0.bin'),'bad!');await assert.rejects(materializeR2Objects({extractedDirectory:extracted,targetDirectory:join(f.base,'tampered-storage')}),/changed/);
  }finally{await rm(f.base,{recursive:true,force:true});}
});

test('R2 REST weak quoted HTTP ETag matches bare list version while conditional GET stays strong',async()=>{
  const etag='0123456789abcdef0123456789abcdef';
  let seen;
  const client=r2ReadClient({accountId:'a'.repeat(32),token:'synthetic',async request(_url,init){seen=init.headers['if-match'];return new Response('synthetic',{headers:{etag:`W/"${etag}"`}});}});
  assert.equal(await new Response(await client.get('synthetic',{key:'private/key',etag})).text(),'synthetic');
  assert.equal(seen,`"${etag}"`);
  const changed=r2ReadClient({accountId:'a'.repeat(32),token:'synthetic',async request(){return new Response('synthetic',{headers:{etag:'W/"different-version"'}});}});
  await assert.rejects(changed.get('synthetic',{key:'private/key',etag}),/changed/);
  const precondition=r2ReadClient({accountId:'a'.repeat(32),token:'synthetic',async request(){return new Response('private-details',{status:412});}});
  await assert.rejects(precondition.get('synthetic',{key:'private/key',etag}),/HTTP 412/);
});
