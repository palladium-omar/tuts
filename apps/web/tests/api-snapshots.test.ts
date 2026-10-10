import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApi,clearApi} from '../lib/api';
import {ListCache} from '../lib/list-cache';

test('Reporting POST cache isolates body, context and fresh reads; mutations invalidate affected domains', async () => {
 const original=globalThis.fetch; const calls:string[]=[];
 globalThis.fetch=async (url,init)=>{calls.push(`${url} ${init?.body??''}`);return new Response(JSON.stringify({items:[],revision:calls.length}),{status:200});};
 try {
  const api=createApi('tenant-a');const body={studentIds:['a'],includeFinancial:false};
  await Promise.all([api('reporting/v1/summaries','POST',body),api('reporting/v1/summaries','POST',body)]);
  assert.equal(calls.length,1);
  await api('reporting/v1/summaries','POST',{...body,includeFinancial:true});assert.equal(calls.length,2);
  await api('planning/v1/boards');await api('clients/v1/clients');
  await api('clients/v1/clients/a','PATCH',{});
  await api('planning/v1/boards');assert.equal(calls.length,5);
  await api('clients/v1/clients');await api('reporting/v1/summaries','POST',body);assert.equal(calls.length,7);
  await api('reporting/v1/summaries','POST',body,undefined,{fresh:true});assert.equal(calls.length,8);
  await createApi('tenant-b')('reporting/v1/summaries','POST',body);assert.equal(calls.length,9);
  clearApi(api);await api('planning/v1/boards');assert.equal(calls.length,10);
  await api('platform/v1/session');await api('platform/v1/session');assert.equal(calls.length,12);
 } finally {globalThis.fetch=original;}
});
test('retained exact list snapshots expire and targeted invalidation removes stale data',()=>{
 const cache=new ListCache();cache.put('clients/v1/clients?offset=0',{items:[{id:'a'}]},1000);
 assert.equal(cache.get('clients/v1/clients?offset=0',31001),undefined);
 assert.equal(cache.snapshot('clients/v1/clients?offset=0',31001)?.data.items[0]?.id,'a');
 assert.equal(cache.snapshot('clients/v1/clients?offset=50',31001),undefined);
 assert.equal(cache.snapshot('clients/v1/clients?offset=0',121000),undefined);
 cache.invalidate(path=>path.startsWith('clients/'));assert.equal(cache.snapshot('clients/v1/clients?offset=0',1001),undefined);
});

test('list invalidation affects only matching active request generations and notifies affected views',()=>{
 const cache=new ListCache();let clients=0,billing=0;
 const offClients=cache.subscribe('clients/v1/clients',()=>clients++);
 const offBilling=cache.subscribe('billing/v1/work-log',()=>billing++);
 const clientVersion=cache.version('clients/v1/clients');
 cache.invalidate(path=>path.startsWith('billing/'));
 assert.equal(cache.version('clients/v1/clients'),clientVersion);assert.equal(clients,0);assert.equal(billing,1);
 assert.notEqual(cache.version('billing/v1/work-log'),undefined);
 offClients();offBilling();
});
test('authorization failures revoke retained lists and notify mounted consumers',async()=>{
 const {onApiInvalidation}=await import('../lib/api');
 const original=globalThis.fetch;const api=createApi('tenant');const cache=new ListCache();let notified=0;
 cache.put('clients/v1/clients',{items:[{id:'private'}]});cache.subscribe('clients/v1/clients',()=>notified++);
 onApiInvalidation(api,(matches,reason)=>cache.invalidate(matches,reason==='access'));
 globalThis.fetch=async()=>new Response(JSON.stringify({message:'forbidden'}),{status:403});
 try {await assert.rejects(api('clients/v1/clients',undefined,undefined,undefined,{fresh:true}));
  assert.equal(cache.accessRevoked,true);assert.equal(cache.get('clients/v1/clients'),undefined);assert.equal(cache.snapshot('clients/v1/clients'),undefined);assert.equal(notified,1);
 } finally {globalThis.fetch=original;}
});
