/** Local encrypted off-Cloudflare backup. No remote writes, app starts or deletes.
 * Create requires a coordinated writers-frozen SQL+R2 capture window. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, stat, lstat, realpath, mkdir, mkdtemp, readdir, open, rm, link, unlink } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { root, serviceNames } from './cloudflare.mjs';
import { loadSnapshot, digest } from './restore-hosted-snapshot.mjs';
const MAGIC = Buffer.from('TUTSBK1\n');
const MAX_OBJECT = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 4 * 1024 ** 3;
const MAX_ENTRIES = 100000;
const fail = message => { throw Object.assign(new Error(message), { recoverySafe: true }); };
const safePath = value => typeof value === 'string' && value.length < 4096 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..');
export async function readBackupKey(path) {
  const actual = await realpath(path), info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077)) fail('Backup key must be a private regular file (mode 600)');
  if (actual === root.slice(0,-1) || actual.startsWith(root)) fail('Keep backup encryption key outside the repository');
  const raw = await readFile(actual);
  const key = raw.length === 32 ? raw : /^[a-f\d]{64}$/i.test(raw.toString().trim()) ? Buffer.from(raw.toString().trim(),'hex') : Buffer.from(raw.toString().trim(),'base64');
  if (key.length !== 32) fail('Backup key must contain 32 random bytes or their hex/base64 encoding');
  return key;
}
export async function wranglerToken(accountId) {
  return new Promise((accept,reject) => {
    const authEnv={...process.env,XDG_CONFIG_HOME:join(root,'.cloudflare/cli-config'),CI:'true',CLOUDFLARE_ACCOUNT_ID:accountId,WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false'};
    delete authEnv.WRANGLER_LOG;
    const child = spawn('pnpm',['exec','wrangler','auth','token','--json'],{cwd:root,env:authEnv,stdio:['ignore','pipe','pipe']});
    let result='';child.stdout.on('data',chunk=>{result+=chunk;if(result.length>32768)child.kill();});child.stderr.resume();
    child.once('error',()=>reject(Object.assign(new Error('Authorized Wrangler authentication unavailable'),{recoverySafe:true})));
    child.once('close',code=>{try{const value=JSON.parse(result);if(code||!['oauth','api_token'].includes(value.type)||typeof value.token!=='string'||!value.token)throw new Error();accept(value.token);}catch{reject(Object.assign(new Error('Refresh Wrangler authorization before backup; no token was printed'),{recoverySafe:true}));}});
  });
}
/** R2 REST can expose a weak HTTP representation ETag for the same object
 * version that listing reports as a bare strong tag. Remove only the standard
 * weak/quoted wrapper; never change the opaque tag value or infer a new hash. */
export function normalizeR2ETag(value) {
  if(typeof value!=='string')fail('R2 object ETag is missing');
  let tag=value.trim();
  if(tag.startsWith('W/'))tag=tag.slice(2);
  if(tag.startsWith('"')&&tag.endsWith('"'))tag=tag.slice(1,-1);
  if(!tag||tag.length>200||/["\\\x00-\x20\x7f]/.test(tag))fail('Invalid R2 object ETag');
  return tag;
}
export function r2ReadClient({accountId,token,request=fetch}) {
  if (!/^[a-f\d]{32}$/i.test(accountId)||!token) fail('R2 account authorization is required');
  const endpoint=bucket=>`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects`;
  async function getResponse(url,headers={}) {
    const response=await request(url,{headers:{authorization:`Bearer ${token}`,...headers},redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok){await response.body?.cancel();fail(`R2 read failed (HTTP ${response.status}); private details withheld`);}return response;
  }
  return {
    async list(bucket) {
      const objects=[],cursors=new Set();let cursor;
      do {
        const url=new URL(endpoint(bucket));url.searchParams.set('per_page','1000');if(cursor)url.searchParams.set('cursor',cursor);
        const body=await (await getResponse(url)).json();
        if(body.success!==true||!Array.isArray(body.result))fail('Unexpected R2 list response');
        for(const item of body.result){if(typeof item.key!=='string'||!Number.isSafeInteger(item.size)||item.size<0||typeof item.etag!=='string'||item.ssec)fail('Unsupported R2 object metadata');objects.push(item);if(objects.length>MAX_ENTRIES)fail('R2 object inventory exceeds budget');}
        const next=body.result_info?.cursor;
        if(body.result_info?.is_truncated){if(typeof next!=='string'||!next||cursors.has(next))fail('Invalid R2 pagination cursor');cursors.add(next);cursor=next;}else cursor=undefined;
      }while(cursor);
      if(new Set(objects.map(o=>o.key)).size!==objects.length)fail('Duplicate R2 keys in inventory');
      return objects.sort((a,b)=>a.key.localeCompare(b.key));
    },
    async get(bucket,object) {
      // Preserve key separators while encoding components; keys never become local paths.
      const key=object.key.split('/').map(encodeURIComponent).join('/');
      const expected=normalizeR2ETag(object.etag);
      const response=await getResponse(`${endpoint(bucket)}/${key}`,{'if-match':`"${expected}"`,'accept-encoding':'identity'});
      let etag;
      try { etag=normalizeR2ETag(response.headers.get('etag')); }
      catch(error) { await response.body?.cancel(); throw error; }
      if(etag!==expected){await response.body?.cancel();fail('R2 object changed during backup');}
      return response.body;
    },
  };
}
async function sourceFiles(directory,prefix) {
  const base=await realpath(directory),files=[];
  async function walk(relative='') {
    for(const entry of await readdir(join(base,relative),{withFileTypes:true})){
      const next=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())fail('Backup source symlinks are refused');
      if(entry.isDirectory())await walk(next);
      else if(entry.isFile()){
        // Prior restore receipts are operational evidence, not part of the DB archive.
        if(prefix==='snapshot' && /\.receipt\.json$/.test(next))continue;
        const path=join(base,next),size=(await stat(path)).size;
        files.push({path:`${prefix}/${next}`,size,stream:()=>createReadStream(path),source:path});
      }else fail('Unsupported backup source file');
    }
  }
  await walk();return files;
}
async function optionalPrivateFile(path,name) {
  try {
    const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())fail('Private config must be a regular file');
    return {path:name,size:info.size,stream:()=>createReadStream(path),source:path};
  }catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}
export async function createBackup({snapshotDirectory,keyFile,outputFile,configDirectory=join(root,'.cloudflare'),r2Client,frozen=false,freezeStartedAt,maxTotalBytes=DEFAULT_MAX_TOTAL}) {
  if(!frozen)fail('Pause writers/cron/queues through both SQL and R2 capture, then provide --writers-frozen');
  const started=Date.now(),snapshot=await loadSnapshot(snapshotDirectory),key=await readBackupKey(keyFile);
  const freezeTime=Date.parse(freezeStartedAt),snapshotTime=Date.parse(snapshot.manifest.createdAt);
  if(!Number.isFinite(freezeTime)||!Number.isFinite(snapshotTime)||freezeTime>snapshotTime||snapshotTime>started||started-freezeTime>2*60*60*1000)fail('Provide --freeze-start ISO_TIMESTAMP from the current coordinated window; snapshot must follow freeze and capture must finish within two hours');
  if(!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<1||maxTotalBytes>1024**4)fail('Invalid backup byte budget');
  const output=resolve(outputFile),parent=await realpath(dirname(output));
  if(parent===root.slice(0,-1)||parent.startsWith(root))fail('Encrypted backup destination must be outside the repository/off Cloudflare');
  const config=JSON.parse(await readFile(join(configDirectory,'deployment.json'),'utf8'));
  if(!/^[a-z][a-z0-9-]{0,29}$/.test(config.prefix))fail('Invalid configured bucket prefix');
  const client=r2Client??r2ReadClient({accountId:config.accountId,token:await wranglerToken(config.accountId)});
  const files=await sourceFiles(snapshot.base,'snapshot');
  for(const name of ['deployment.json','secrets.json']){
    const file=await optionalPrivateFile(join(configDirectory,name),`private/${name}`);if(!file)fail('Deployment configuration and key secrets are required');files.push(file);
  }
  for(const name of serviceNames.concat('gateway')){
    const file=await optionalPrivateFile(join(configDirectory,'generated',name,'wrangler.json'),`private/generated/${name}/wrangler.json`);if(file)files.push(file);
  }
  const buckets=[`${config.prefix}-uploads`,`${config.prefix}-event-payloads`],inventories={};
  const objects=[];
  for(const bucket of buckets){
    inventories[bucket]=await client.list(bucket);
    for(const object of inventories[bucket]){
      if(object.size>MAX_OBJECT)fail('R2 object exceeds 32 MiB backup budget; review domain limits');
      const index=objects.length;objects.push({bucket,...object,file:`r2/objects/${index}.bin`});
      files.push({path:`r2/objects/${index}.bin`,size:object.size,stream:()=>client.get(bucket,object)});
    }
  }
  const uploadKeys=new Map(inventories[`${config.prefix}-uploads`].map(object=>[object.key,object]));
  for(const raw of snapshot.services.learning.tables.resources??[]) {
    const resource=JSON.parse(raw);
    if(resource.storage_status!=='stored')continue;
    const object=uploadKeys.get(`${resource.business_id}/${resource.storage_key}`);
    if(!object||object.size!==Number(resource.size_bytes))fail('Stored learning resource is missing or differs in R2; backup coverage is incomplete');
  }
  if(files.length>MAX_ENTRIES||files.reduce((n,f)=>n+f.size,0)>maxTotalBytes)fail('Backup exceeds total resource budget');
  // Freeze config/source identities too; never claim a coherent backup if any changes.
  const sourceHashes=new Map();for(const file of files.filter(f=>f.source)){const hash=createHash('sha256');for await(const chunk of file.stream())hash.update(chunk);sourceHashes.set(file.path,hash.digest('hex'));}
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(MAGIC);
  const temp=join(parent,`.tuts-backup-${randomBytes(8).toString('hex')}.partial`);
  const entries=[];
  async function* records(){
    for(const file of files){
      if(!safePath(file.path))fail('Unsafe backup entry path');
      yield Buffer.from(`${JSON.stringify({path:file.path,size:file.size})}\n`);
      const hash=createHash('sha256');let size=0;
      for await(const chunk of await file.stream()){size+=chunk.length;if(size>file.size)fail('Backup source grew during capture');hash.update(chunk);yield chunk;}
      if(size!==file.size)fail('Backup source size changed during capture');
      const sha256=hash.digest('hex');if(file.source&&sourceHashes.get(file.path)!==sha256)fail('Backup source changed during capture');
      entries.push({path:file.path,size,sha256});yield Buffer.from('\n');
    }
    for(const bucket of buckets){const after=await client.list(bucket);if(JSON.stringify(after)!==JSON.stringify(inventories[bucket]))fail('R2 inventory changed during capture; keep writers frozen and retry');}
    const manifest={version:1,createdAt:new Date().toISOString(),snapshotCreatedAt:snapshot.manifest.createdAt,writersFrozenAttested:true,freezeStartedAt,entries,r2Objects:objects,resourceBudgetBytes:maxTotalBytes,limitations:['No hosted restore performed','Backup key is external and must be escrowed separately','Role/grant and external-provider recovery require review']};
    const raw=Buffer.from(JSON.stringify(manifest));if(raw.length>16*1024*1024)fail('Backup metadata exceeds resource budget');yield Buffer.from(`${JSON.stringify({path:'bundle-manifest.json',size:raw.length})}\n`);yield raw;yield Buffer.from('\n');yield Buffer.from('{"end":true}\n');
  }
  try{
    await writeFile(temp,Buffer.concat([MAGIC,nonce]),{mode:0o600,flag:'wx'});
    await pipeline(Readable.from(records()),cipher,createWriteStream(temp,{flags:'a',mode:0o600}));
    const handle=await open(temp,'a');try{await handle.write(cipher.getAuthTag());await handle.sync();}finally{await handle.close();}
    // Exclusive publication never replaces an existing backup, even after a race.
    await link(temp,output);await unlink(temp);
    const verification=await verifyBackup({backupFile:output,keyFile,maxTotalBytes});
    const receipt={version:1,createdAt:new Date().toISOString(),cipher:'AES-256-GCM',encryptedBytes:(await stat(output)).size,plaintextBytes:verification.bytes,entries:verification.entries,r2Objects:objects.length,snapshotCreatedAt:snapshot.manifest.createdAt,durationMs:Date.now()-started,authenticated:true,offCloudflareLocalCopy:true};
    await writeFile(`${output}.receipt.json`,JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
    return receipt;
  }finally{key.fill(0);await rm(temp,{force:true});}
}
async function parseFrames(payload,target,maxTotalBytes) {
  const iterator=createReadStream(payload,{highWaterMark:1024*1024})[Symbol.asyncIterator]();let buffer=Buffer.alloc(0),eof=false;
  async function fill(){if(buffer.length||eof)return;const item=await iterator.next();if(item.done)eof=true;else buffer=item.value;}
  async function line(){const parts=[];let size=0;while(true){await fill();if(eof)fail('Incomplete backup frame');const index=buffer.indexOf(10);const chunk=index<0?buffer:buffer.subarray(0,index);parts.push(chunk);size+=chunk.length;if(size>8192)fail('Oversized backup frame header');buffer=index<0?Buffer.alloc(0):buffer.subarray(index+1);if(index>=0)return Buffer.concat(parts).toString('utf8');}}
  const actual=new Map();let total=0,manifest;
  try{
    while(true){const header=JSON.parse(await line());if(header.end===true){await fill();if(buffer.length||!eof)fail('Trailing backup bytes');break;}
      if(manifest||!safePath(header.path)||(!/^(snapshot|private|r2)\//.test(header.path)&&header.path!=='bundle-manifest.json')||actual.has(header.path)||!Number.isSafeInteger(header.size)||header.size<0)fail('Invalid or duplicate backup entry');
      total+=header.size;if(total>maxTotalBytes+16*1024*1024||actual.size>=MAX_ENTRIES)fail('Extraction exceeds resource budget');
      const path=join(target,header.path);await mkdir(dirname(path),{recursive:true,mode:0o700});const file=await open(path,'wx',0o600),hash=createHash('sha256');let remaining=header.size;
      try{while(remaining){await fill();if(eof)fail('Truncated backup entry');const chunk=buffer.subarray(0,Math.min(buffer.length,remaining));buffer=buffer.subarray(chunk.length);remaining-=chunk.length;hash.update(chunk);await file.writeFile(chunk);}}finally{await file.close();}
      if(await line()!=='')fail('Missing backup frame delimiter');actual.set(header.path,{size:header.size,sha256:hash.digest('hex')});
      if(header.path==='bundle-manifest.json')manifest=JSON.parse(await readFile(path,'utf8'));
    }
    if(!manifest||manifest.version!==1||!Array.isArray(manifest.entries)||manifest.entries.length!==actual.size-1)fail('Invalid bundle manifest');
    const names=new Set();for(const entry of manifest.entries){if(names.has(entry.path))fail('Duplicate manifest entry');names.add(entry.path);const found=actual.get(entry.path);if(!found||found.size!==entry.size||found.sha256!==entry.sha256)fail('Bundle content integrity failed');}
    await loadSnapshot(join(target,'snapshot'));
    for(const object of manifest.r2Objects??[]){const entry=actual.get(object.file);if(!entry||entry.size!==object.size)fail('R2 inventory/content coverage differs');}
    return {entries:manifest.entries.length,bytes:manifest.entries.reduce((n,e)=>n+e.size,0),r2Objects:manifest.r2Objects.length,manifest};
  }finally{await iterator.return?.();}
}
export async function extractBackup({backupFile,keyFile,targetDirectory,maxTotalBytes=DEFAULT_MAX_TOTAL}) {
  const target=resolve(targetDirectory),key=await readBackupKey(keyFile),parent=await realpath(dirname(target));
  const stage=await mkdtemp(join(parent,'.tuts-extract-'));const payload=join(stage,'authenticated-payload');let created=false;
  try{
    const size=(await stat(backupFile)).size;if(size<MAGIC.length+12+16||size>maxTotalBytes+32*1024*1024)fail('Encrypted backup exceeds resource budget or is truncated');
    const handle=await open(backupFile,'r');let nonce,tag;
    try{const head=Buffer.alloc(MAGIC.length+12);await handle.read(head,0,head.length,0);if(!head.subarray(0,MAGIC.length).equals(MAGIC))fail('Unknown backup format');nonce=head.subarray(MAGIC.length);tag=Buffer.alloc(16);await handle.read(tag,0,16,size-16);}finally{await handle.close();}
    const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(MAGIC);decipher.setAuthTag(tag);
    try{await pipeline(createReadStream(backupFile,{start:MAGIC.length+12,end:size-17}),decipher,createWriteStream(payload,{flags:'wx',mode:0o600}));}catch{fail('Backup authentication failed; no restore files extracted');}
    await mkdir(target,{mode:0o700});created=true;
    const result=await parseFrames(payload,target,maxTotalBytes);
    await writeFile(join(target,'BACKUP_AUTHENTICATED.json'),JSON.stringify({version:1,verifiedAt:new Date().toISOString(),entries:result.entries,bytes:result.bytes,r2Objects:result.r2Objects},null,2),{mode:0o600,flag:'wx'});
    return {entries:result.entries,bytes:result.bytes,r2Objects:result.r2Objects};
  }catch(error){if(created)await rm(target,{recursive:true,force:true});throw error;}finally{key.fill(0);await rm(stage,{recursive:true,force:true});}
}
export async function verifyBackup(options) {
  const parent=await mkdtemp(join(tmpdir(),'tuts-backup-check-'));
  try{return await extractBackup({...options,targetDirectory:join(parent,'extracted')});}finally{await rm(parent,{recursive:true,force:true});}
}
/** Recreate only known private object-key layouts in a NEW LOCAL filesystem.
 * Original metadata remains in the authenticated bundle; no R2 PUT occurs. */
export async function materializeR2Objects({extractedDirectory,targetDirectory}) {
  await readFile(join(extractedDirectory,'BACKUP_AUTHENTICATED.json'));
  const manifest=JSON.parse(await readFile(join(extractedDirectory,'bundle-manifest.json'),'utf8'));
  const entries=new Map(manifest.entries.map(entry=>[entry.path,entry]));
  const uuid='[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
  const upload=new RegExp(`^${uuid}/${uuid}$`),event=new RegExp(`^v1/(?:${serviceNames.join('|')})/${uuid}/${uuid}\\.json$`);
  const target=resolve(targetDirectory);let created=false,count=0;
  try {
    await mkdir(target,{mode:0o700});created=true;
    for(const object of manifest.r2Objects) {
      const isUpload=object.bucket.endsWith('-uploads'),isEvent=object.bucket.endsWith('-event-payloads');
      if(!safePath(object.file)||!((isUpload&&upload.test(object.key))||(isEvent&&event.test(object.key))))fail('Object key is outside known private storage layouts');
      const source=join(extractedDirectory,object.file),expected=entries.get(object.file),hash=createHash('sha256');let bytes=0;
      const destination=join(target,isUpload?'uploads':'event-payloads',object.key);await mkdir(dirname(destination),{recursive:true,mode:0o700});const output=await open(destination,'wx',0o600);
      try {for await(const chunk of createReadStream(source)){bytes+=chunk.length;if(bytes>MAX_OBJECT)fail('Object exceeds local storage budget');hash.update(chunk);await output.writeFile(chunk);}}finally{await output.close();}
      if(!expected||bytes!==expected.size||hash.digest('hex')!==expected.sha256)fail('Extracted object changed before local materialization');count++;
    }
    await writeFile(join(target,'LOCAL_STORAGE_VERIFIED.json'),JSON.stringify({version:1,verifiedAt:new Date().toISOString(),objects:count,remoteWrites:false},null,2),{mode:0o600,flag:'wx'});
    return {objects:count,remoteWrites:false};
  }catch(error){if(created)await rm(target,{recursive:true,force:true});throw error;}
}
export async function retentionReport(directory,{now=Date.now(),days=30,minimumCopies=7}={}) {
  if(!Number.isInteger(days)||days<7||!Number.isInteger(minimumCopies)||minimumCopies<2)fail('Retention requires at least seven days and two copies');
  const files=[];
  for(const name of await readdir(directory)){
    if(!name.endsWith('.tuts-backup'))continue;
    const info=await lstat(join(directory,name));if(!info.isFile()||info.isSymbolicLink())continue;
    try{const receipt=JSON.parse(await readFile(join(directory,`${name}.receipt.json`),'utf8'));if(receipt.authenticated!==true||receipt.encryptedBytes!==info.size)continue;files.push({name,createdAt:receipt.createdAt,bytes:info.size});}catch{ /* Incomplete/unverified files are never expiration candidates. */ }
  }
  files.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  return files.map((file,index)=>({...file,action:index<minimumCopies||now-Date.parse(file.createdAt)<days*86400000?'retain':'review_expiration',deleted:false}));
}
async function main(){
  const args=process.argv.slice(2),command=args.shift(),values={};
  while(args.length){const flag=args.shift();if(flag==='--writers-frozen'){values[flag]=true;continue;}if(!['--snapshot','--key-file','--output','--backup','--target','--directory','--max-total-bytes','--freeze-start','--extracted'].includes(flag)||!args[0]||args[0].startsWith('--')||values[flag])fail('Invalid backup option');values[flag]=args.shift();}
  const budget=values['--max-total-bytes']?Number(values['--max-total-bytes']):DEFAULT_MAX_TOTAL;
  if(command==='create'){if(!values['--snapshot']||!values['--key-file']||!values['--output'])fail('Create requires --snapshot, --key-file, --output and --writers-frozen');const receipt=await createBackup({snapshotDirectory:values['--snapshot'],keyFile:values['--key-file'],outputFile:values['--output'],frozen:values['--writers-frozen'],freezeStartedAt:values['--freeze-start'],maxTotalBytes:budget});console.log(`Encrypted local backup verified: ${receipt.entries} entries, ${receipt.r2Objects} R2 objects; ${receipt.durationMs} ms. No hosted restore performed.`);}
  else if(command==='verify'||command==='extract'){if(!values['--backup']||!values['--key-file']||(command==='extract'&&!values['--target']))fail('Verify/extract requires --backup --key-file and a new --target for extraction');const result=await (command==='verify'?verifyBackup:extractBackup)({backupFile:values['--backup'],keyFile:values['--key-file'],targetDirectory:values['--target'],maxTotalBytes:budget});console.log(`Authenticated ${result.entries} entries and ${result.r2Objects} R2 objects.`);}
  else if(command==='materialize-local'){if(!values['--extracted']||!values['--target'])fail('Local storage materialization requires --extracted and a new --target');const result=await materializeR2Objects({extractedDirectory:values['--extracted'],targetDirectory:values['--target']});console.log(`Verified ${result.objects} objects in isolated local storage; zero remote writes.`);}
  else if(command==='retention-report'){if(!values['--directory'])fail('Retention report requires --directory');const report=await retentionReport(values['--directory']);console.log(`Retention review only: ${report.filter(f=>f.action==='retain').length} retained, ${report.filter(f=>f.action==='review_expiration').length} expiration candidates; zero files deleted.`);}
  else if(command==='inventory'){const config=JSON.parse(await readFile(join(root,'.cloudflare/deployment.json'),'utf8'));const client=r2ReadClient({accountId:config.accountId,token:await wranglerToken(config.accountId)});for(const bucket of [`${config.prefix}-uploads`,`${config.prefix}-event-payloads`]){const objects=await client.list(bucket);console.log(`${bucket}: ${objects.length} objects, ${objects.reduce((n,o)=>n+o.size,0)} bytes; no keys or private contents printed.`);}}
  else fail('Commands: create, verify, extract, materialize-local, inventory, retention-report');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.recoverySafe?error.message:'Backup stopped; private error details withheld');process.exitCode=1;});
