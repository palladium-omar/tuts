import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RequestCache,waitForRead} from '../lib/request-cache';
import {ListCache} from '../lib/list-cache';

test('identical reads share one request and return isolated values',async()=>{
 const cache=new RequestCache();let calls=0;
 const load=async()=>{calls++;return {items:[{name:'Student'}]};};
 const [a,b]=await Promise.all([cache.read('students',load),cache.read('students',load)]);
 a.items[0]!.name='Changed';assert.equal(b.items[0]!.name,'Student');assert.equal(calls,1);
 assert.equal((await cache.read('students',load)).items[0]!.name,'Student');assert.equal(calls,1);
});
test('mutation invalidation rejects late old reads as cache entries',async()=>{
 const cache=new RequestCache();let finish!:(value:{revision:number})=>void;
 const old=cache.read('students',()=>new Promise<{revision:number}>(resolve=>{finish=resolve;}));
 cache.clear();await cache.read('students',async()=>({revision:2}));finish({revision:1});await old;
 assert.equal((await cache.read('students',async()=>({revision:3}))).revision,2);
});
test('expired reads refetch, errors are retriable, and API contexts do not share data',async()=>{
 const cache=new RequestCache();await cache.read('students',async()=>1);
 assert.equal(await cache.read('students',async()=>2,Date.now()+15001),2);
 await assert.rejects(cache.read('failed',async()=>{throw new Error('offline');}));
 assert.equal(await cache.read('failed',async()=>3),3);
 assert.equal(await new RequestCache().read('students',async()=>4),4);
});
test('aborting a subscriber leaves other consumers of the shared read intact',async()=>{
 const cache=new RequestCache();let finish!:(value:number)=>void;
 const task=cache.read('students',()=>new Promise<number>(resolve=>{finish=resolve;}));
 const controller=new AbortController();const aborted=waitForRead(task,controller.signal);
 controller.abort();await assert.rejects(aborted,{name:'AbortError'});finish(8);
 assert.equal(await waitForRead(task),8);assert.equal(await cache.read('students',async()=>9),8);
});
test('list cache never guesses results for other filters or related contact identities',()=>{
 const cache=new ListCache();const path='clients/v1/clients?kind=student&limit=50&offset=0';
 cache.put(path,{items:[{displayName:'Alex'}],total:1},1000);
 assert.equal(cache.get(path,1001)?.data.total,1);
 assert.equal(cache.get(`${path}&search=parent@example.test`,1001),undefined);
 assert.equal(cache.get(path,31000),undefined);
 assert.equal(new ListCache().get(path,1001),undefined);
});

test('history amounts respect currency precision and reject unsafe or malformed values',async()=>{
 const {decimalMinor}=await import('../lib/history-money');
 assert.equal(decimalMinor('35.75','EUR'),3575);assert.equal(decimalMinor('35,75','EUR'),3575);
 assert.equal(decimalMinor('100','JPY'),100);assert.equal(decimalMinor('1.234','KWD'),1234);
 assert.throws(()=>decimalMinor('1.2','JPY'));assert.throws(()=>decimalMinor('1.234','EUR'));
 assert.throws(()=>decimalMinor('9007199254740992','EUR'));assert.throws(()=>decimalMinor('1e4','EUR'));
});

import {canNavigateTutor} from "../lib/tutor-workspace";
test("dashboard navigation remains available without a feature-registry entry",()=>{
  assert.equal(canNavigateTutor("dashboard",["clients"],false),true);
  assert.equal(canNavigateTutor("clients",["clients"],false),true);
  assert.equal(canNavigateTutor("billing",["clients"],false),false);
  assert.equal(canNavigateTutor("settings",[],false),false);
  assert.equal(canNavigateTutor("settings",[],true),true);
});
