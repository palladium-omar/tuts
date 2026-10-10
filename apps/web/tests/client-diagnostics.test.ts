import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEvent,installClientDiagnostics,portalDiagnosticView} from '../lib/client-diagnostics';
import type {Api} from '../lib/api';

test('diagnostics transmit only allowlisted kind, source and view',()=>{
 const error=new TypeError('private student@example.test token secret');
 assert.deepEqual(diagnosticEvent(error,'window','clients'),{kind:'TypeError',source:'window',view:'crm'});
 assert.deepEqual(diagnosticEvent({name:'TypeError',studentId:'private'},'promise','private-url'),{kind:'UnknownError',source:'promise',view:'other'});
 error.name='private';assert.equal(diagnosticEvent(error,'window','dashboard').kind,'UnknownError');
});
test('diagnostic queue is capped at ten, lifetime budget at fifty, failures never retry and cleanup detaches',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const target=new EventTarget();const batches:any[]=[];
 const api:Api=async(path,method,body)=>{assert.equal(path,'platform/v1/client-diagnostics');assert.equal(method,'POST');batches.push(body);throw new Error('offline');};
 const dispose=installClientDiagnostics(api,()=> 'tracker',target as Window);
 const emit=()=>{const event=new Event('error');Object.defineProperty(event,'error',{value:new Error('private')});target.dispatchEvent(event);};
 for(let batch=0;batch<7;batch++) {
  for(let n=0;n<100;n++)emit();
  t.mock.timers.tick(5000);await Promise.resolve();await Promise.resolve();
 }
 assert.equal(batches.length,5);
 assert.ok(batches.every(batch=>batch.events.length===10));
 assert.deepEqual(batches[0].events[0],{kind:'Error',source:'window',view:'tracker'});
 dispose();emit();t.mock.timers.tick(10000);assert.equal(batches.length,5);
});

test('portal diagnostics use coarse safe sections and never track contact or student values',()=>{
 assert.equal(portalDiagnosticView('homework'),'learning');
 assert.equal(portalDiagnosticView('resources'),'learning');
 assert.equal(portalDiagnosticView('sessions'),'scheduling');
 assert.equal(portalDiagnosticView('planning'),'planning');
 assert.equal(portalDiagnosticView('contacts'),'other');
 assert.equal(portalDiagnosticView('private-student@example.test'),'other');
});
