import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {sameDeadline} from '../src/deadline-comparison.js';
import {mergeTemplateResources} from '../src/template-resources.js';
import {planningColumnKind} from '../src/overview.js';
import {overviewQuerySchema,templateApplySchema} from '../src/schemas.js';
test('reviewed additions preserve manual content, IDs and completed state and replay is idempotent',()=>{
 const id=randomUUID(),manual={id,text:'Edited custom step',done:true};
 const existing=[{kind:'link',label:'My label',url:'https://EXAMPLE.com/Case'}];
 const proposed=[{kind:'link',label:'Official label',url:'https://example.com/Case'},{kind:'link',label:'Different path',url:'https://example.com/case'}];
 const result=mergeTemplateResources(existing,[manual],proposed,[{id,text:'Original step',done:false},{id:randomUUID(),text:manual.text,done:false},{id:randomUUID(),text:'New step',done:true}]);
 assert.equal(result.references.length,2);assert.deepEqual(result.references[0],existing[0]);assert.deepEqual(result.checklist[0],manual);assert.equal(result.checklist.length,2);assert.equal(result.checklist[1].done,false);
 const again=mergeTemplateResources(result.references,result.checklist,proposed,result.checklist);assert.equal(again.changed,false);assert.deepEqual(again.references,result.references);assert.deepEqual(again.checklist,result.checklist);
});
test('known column labels classify status and unknown custom labels stay pending',()=>{
 for(const label of ['Done',' completed ','Complete'])assert.equal(planningColumnKind(label),'completed');
 for(const label of ['In progress','in-progress','Review'])assert.equal(planningColumnKind(label),'in_progress');
 for(const label of ['To do','Next','Not done','Completed review'])assert.equal(planningColumnKind(label),'pending');
 assert.throws(()=>overviewQuerySchema.parse({}));assert.throws(()=>overviewQuerySchema.parse({studentId:'invalid'}));
 assert.throws(()=>templateApplySchema.parse({version:3,expectedRevision:1,cardIds:[],resourceCardIds:[randomUUID(),'bad']}));
});

test('deadline comparison ignores JSONB key order, provenance ordering and equivalent timestamp offsets',()=>{
 const current={kind:'official',dueAt:'2027-01-01T12:00:00Z',timeZone:'UTC',sourceUrls:['https://example.com/B','https://example.com/A'],status:'verified',verifiedAt:'2026-10-10T12:00:00Z',cycle:2027,round:'rd',applicability:'Scope'};
 const proposed={applicability:'Scope',round:'rd',cycle:2027,verifiedAt:'2026-10-10T13:00:00+01:00',status:'verified',sourceUrls:['https://example.com/A','https://example.com/B'],timeZone:'UTC',dueAt:'2027-01-01T13:00:00+01:00',kind:'official'};
 assert.equal(sameDeadline(current,proposed),true);assert.equal(sameDeadline(null,undefined),true);
 for(const field of ['kind','dueAt','timeZone','status','verifiedAt','round','applicability'])assert.equal(sameDeadline(current,{...proposed,[field]:'Changed'}),false,field);
 assert.equal(sameDeadline(current,{...proposed,sourceUrls:['https://example.com/a','https://example.com/B']}),false);
});

test('card events expose explicit completion from the same known column labels as overview',async()=>{
 const {cardEvent}=await import('../src/planning.service.js');
 for(const [name,completed] of [['Done',true],[' completed ',true],['Complete',true],['Review',false],['Not done',false]] as const){
  const calls:any[]=[];const ctx:any={businessId:randomUUID(),requestId:randomUUID()};const board:any={id:randomUUID(),student_id:randomUUID(),sharing:'student'};const row:any={id:randomUUID(),column_id:randomUUID(),revision:7};
  const tx:any={query:async(sql:string,args:any[])=>{calls.push({sql,args});return {rows:sql.startsWith('SELECT name')?[{name}]:[]};}};
  await cardEvent(tx,ctx,board,row);
  assert.deepEqual(calls[0].args,[row.column_id,board.id]);assert.match(calls[0].sql,/LIMIT 1/);
  const event=JSON.parse(calls.find(c=>c.sql.startsWith('INSERT INTO service_outbox')).args[1]);assert.equal(event.data.completed,completed);assert.equal(event.data.revision,7);assert.equal(event.businessId,ctx.businessId);
 }
});
