import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {staticContentSecurityPolicy} from '../cloudflare.mjs';
const hash=value=>"'sha256-"+createHash('sha256').update(value).digest('base64')+"'";
test('static CSP hashes exact inline hydration bytes across nested pages, deduplicates and excludes external scripts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tuts-csp-'));
 try {
  await mkdir(join(directory,'portal'));
  const hydration='self.__next_f.push([1,"safe\\nvalue"]);\n';
  await writeFile(join(directory,'index.html'),`<script>${hydration}</script><script src="/_next/a.js">external fallback</script><script></script>`);
  await writeFile(join(directory,'portal/index.html'),`<SCRIPT>${hydration}</SCRIPT><script type="application/json">{"safe":true}</script>`);
  const policy=await staticContentSecurityPolicy(directory);
  assert.ok(policy.includes(hash(hydration)));
  assert.equal(policy.split(hash(hydration)).length-1,1);
  assert.ok(policy.includes(hash('{"safe":true}')));
  assert.ok(!policy.includes(hash('external fallback')));
  const scripts=policy.split('; ').find(value=>value.startsWith('script-src'));
  assert.ok(!scripts.includes("'unsafe-inline'"));assert.ok(!scripts.includes("'unsafe-eval'"));
  assert.ok(policy.includes("object-src 'none'"));assert.ok(policy.includes("frame-ancestors 'none'"));
  await writeFile(join(directory,'index.html'),`<script>${hydration}changed</script>`);
  assert.ok((await staticContentSecurityPolicy(directory)).includes(hash(hydration+'changed')));
 } finally {await rm(directory,{recursive:true,force:true});}
});
test('static CSP fails closed when export is unavailable',async()=>{
 assert.equal(await staticContentSecurityPolicy(join(tmpdir(),'tuts-absent-'+crypto.randomUUID())),null);
});
