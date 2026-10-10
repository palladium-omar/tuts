import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { inflateArchiveEntry } from '../src/archive-inflate.js';

test('bounded streaming handles exact lengths across output chunks, including an empty entry',async()=>{
 for(const size of [0,1,16384,65536,82608,131073]){
  const source=Buffer.alloc(size,65);
  assert.deepEqual(await inflateArchiveEntry(deflateRawSync(source),size),source);
 }
});
test('a forged small size aborts a highly compressed entry',async()=>{
 const compressed=deflateRawSync(Buffer.alloc(20*1024*1024,65));
 await assert.rejects(inflateArchiveEntry(compressed,128),/exceeds declared size/);
 await assert.rejects(inflateArchiveEntry(deflateRawSync(Buffer.from('x')),0),/exceeds declared size/);
});
test('malformed/truncated deflate and invalid expansion limits are rejected',async()=>{
 const compressed=deflateRawSync(Buffer.from('synthetic worksheet'));
 await assert.rejects(inflateArchiveEntry(compressed.subarray(0,compressed.length-2),100));
 await assert.rejects(inflateArchiveEntry(Buffer.from([0xff,0xff]),100));
 for(const limit of [-1,1.5,NaN,20*1024*1024+1])await assert.rejects(inflateArchiveEntry(compressed,limit),/expansion limit/);
});
test('short output remains detectable by the archive validator',async()=>{
 const result=await inflateArchiveEntry(deflateRawSync(Buffer.from('abc')),10);
 assert.equal(result.length,3);
});
