import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {Database} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {PlanningService} from '../src/planning.service.js';
import {templatesForCycle} from '../src/templates.js';
import {templateApplySchema} from '../src/schemas.js';

const ctx:RequestContext={businessId:randomUUID(),sub:'synthetic-owner',role:'owner',entitlements:['planning','clients'],requestId:randomUUID()};
test('future list seeds immutable versions in one tenant transaction and one insert',async()=>{
 const calls:{sql:string;args:any[]}[]=[],tenants:string[]=[];
 const service=new PlanningService({withTenant:async(tenant:string,work:Function)=>{
  tenants.push(tenant);return work({query:async(sql:string,args:any[])=>{calls.push({sql,args});return {rows:[]};}});
 }} as unknown as Database);
 assert.deepEqual(await service.templates(ctx,{cycle:2035}),{items:[],cycle:2035});
 assert.deepEqual(tenants,[ctx.businessId]);assert.equal(calls.length,2);
 assert.match(calls[0]!.sql,/unnest/);assert.match(calls[0]!.sql,/ON CONFLICT DO NOTHING/);
 assert.equal(calls[0]!.args[0],ctx.businessId);
 const definitions=calls[0]!.args[4].map((v:string)=>JSON.parse(v));
 assert.ok(definitions.some((t:any)=>t.key==='common-app-2027'&&t.version===1));
 assert.ok(definitions.some((t:any)=>t.key==='common-app-2027'&&t.version===2));
 assert.ok(definitions.some((t:any)=>t.key==='common-app-2035'&&t.cycle===2035));
 assert.deepEqual(calls[1]!.args,[2035]);
});

function fixture(){
 const definition=templatesForCycle(2027).find(t=>t.key==='common-app-2027')!,studentId=randomUUID(),boardId=randomUUID(),stamp='2026-10-10T19:00:00Z';
 const board:any={id:boardId,business_id:ctx.businessId,student_id:studentId,name:'Synthetic board',sharing:'student',created_by:ctx.sub,revision:5,template_key:definition.key,template_version:1,applicability:{cycle:2027,country:'US',round:definition.round,program:definition.program,applicantCategory:definition.applicantCategory},created_at:stamp,updated_at:stamp};
 const manual={kind:'personal',dueAt:'2026-10-29T12:00:00Z',status:'user_set'};
 const columns:any[]=[{id:randomUUID(),name:'In progress',position:0},{id:randomUUID(),name:'To do',position:1}];
 const cards:any[]=[{id:randomUUID(),board_id:boardId,column_id:columns[1].id,position:7,template_card_key:'college-list',deadline:null,deadline_edited:false,revision:3,updated_at:stamp},{id:randomUUID(),board_id:boardId,column_id:columns[0].id,position:1,template_card_key:'submit',deadline:manual,deadline_edited:true,revision:4,updated_at:stamp}];
 const writes:any[]=[],events:any[]=[],tenants:string[]=[];
 const tx={query:async(sql:string,args:any[]=[])=>{
  if(sql.startsWith('SELECT * FROM planning_boards'))return {rows:[{...board}]};
  if(sql.startsWith('SELECT planning_canonical_student'))return {rows:[{id:studentId}]};
  if(sql.startsWith('SELECT * FROM planning_templates'))return {rows:[{definition}]};
  if(sql.startsWith('SELECT * FROM planning_cards'))return {rows:cards.map(c=>({...c}))};
  if(sql.startsWith('SELECT * FROM planning_columns'))return {rows:columns.map(c=>({...c}))};
  if(sql.startsWith('INSERT INTO planning_cards')){
   const c={id:args[0],business_id:args[1],board_id:args[2],column_id:args[3],position:args[4],title:args[5],description:args[6],checklist:JSON.parse(args[7]),resource_references:JSON.parse(args[8]),deadline:JSON.parse(args[9]),learning_assignment_id:args[10],template_card_key:args[11],created_by:args[12],deadline_edited:false,revision:1,created_at:stamp,updated_at:stamp};
   cards.push(c);return {rows:[{...c}]};
  }
  if(sql.startsWith('UPDATE planning_cards SET deadline=')){const c=cards.find(c=>c.id===args[0]);c.deadline=JSON.parse(args[1]);c.revision++;writes.push(c.id);return {rows:[{...c}]};}
  if(sql.startsWith('UPDATE planning_boards SET template_version=')){board.template_version=args[1];return {rows:[]};}
  if(sql.startsWith('UPDATE planning_boards SET revision=')){board.revision++;return {rows:[{...board}]};}
  if(sql.startsWith('INSERT INTO service_outbox')){events.push(JSON.parse(args[1]));return {rows:[]};}
  throw new Error(`Unexpected SQL: ${sql}`);
 }};
 const service=new PlanningService({withTenant:async(tenant:string,work:Function)=>{tenants.push(tenant);return work(tx);}} as unknown as Database);
 return {service,definition,board,cards,columns,manual,writes,events,tenants};
}
test('review and explicit application preserve edited dates and emit only changed cards',async()=>{
 const f=fixture(),before=structuredClone(f.cards);
 const review=await f.service.reviewTemplate(ctx,f.board.id,2);
 assert.equal(review.automaticApply,false);assert.deepEqual(f.cards,before);assert.equal(f.writes.length,0);
 assert.equal(review.suggestions.find(s=>s.cardId===f.cards[1]!.id)!.preserveUserEdit,true);
 assert.ok(review.addedCards.some(c=>c.key==='sat-rd-test'));
 const result=await f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:5,cardIds:f.cards.map(c=>c.id)});
 assert.deepEqual(result.preservedCardIds,[f.cards[1]!.id]);assert.deepEqual(f.cards[1]!.deadline,f.manual);
 assert.deepEqual(f.writes,[f.cards[0]!.id]);assert.equal(result.board.templateVersion,2);assert.equal(result.board.revision,6);
 assert.equal(f.events.filter(e=>e.type==='planning.card-updated.v1').length,1);
 assert.ok(f.events.every(e=>e.businessId===ctx.businessId));assert.ok(f.tenants.every(tenant=>tenant===ctx.businessId));
});
test('template update rejects stale revisions, rollback, changed scope and actors outside the board grant',async()=>{
 let f=fixture();await assert.rejects(f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:4,cardIds:[]}),/Board changed/);assert.deepEqual(f.writes,[]);
 f=fixture();f.board.template_version=3;await assert.rejects(f.service.reviewTemplate(ctx,f.board.id,2),/cannot roll back/);
 f=fixture();f.board.applicability.cycle=2028;await assert.rejects(f.service.reviewTemplate(ctx,f.board.id,2),/requires a new board/);
 f=fixture();await assert.rejects(f.service.reviewTemplate({...ctx,role:'tutor',sub:'another-tutor'},f.board.id,2),/Only the board creator/);
 f=fixture();await assert.rejects(f.service.reviewTemplate({...ctx,role:'tutor',accessScope:'students',studentIds:[randomUUID()]},f.board.id,2),/Student access/);assert.deepEqual(f.writes,[]);
});
test('reviewed added tasks append to template-matching columns and a retry never duplicates them',async()=>{
 const f=fixture(),custom={...f.cards[0],id:randomUUID(),title:'My own SAT plan',template_card_key:null,deadline:{...f.manual},deadline_edited:true};
 f.cards.push(custom);
 const review=await f.service.reviewTemplate(ctx,f.board.id,2),preview=review.addedCards.find(c=>c.key==='sat-rd-test')!;
 assert.equal(preview.destinationColumnId,f.columns[1].id);assert.ok(preview.description);assert.ok(preview.deadline?.dueAt);
 const result=await f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:5,cardIds:[f.cards[1].id],addedCardKeys:['sat-rd-test','financial-aid-rd']});
 assert.equal(result.addedCards.length,2);assert.equal(result.cards.length,2);assert.equal(result.board.revision,6);
 assert.deepEqual(f.cards.find(c=>c.id===custom.id),custom);assert.deepEqual(f.cards[1].deadline,f.manual);
 assert.ok(result.addedCards.every(c=>c.columnId===preview.destinationColumnId&&c.deadline?.dueAt&&c.deadlineEdited===false));
 assert.deepEqual(result.addedCards.map(c=>c.position),[8,9]);
 assert.equal(f.events.filter(e=>e.type==='planning.card-updated.v1').length,2);
 const initialIds=result.addedCards.map(c=>c.id);
 await assert.rejects(f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:5,cardIds:[],addedCardKeys:['sat-rd-test']}),/Board changed/);
 const retry=await f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:6,cardIds:[],addedCardKeys:['sat-rd-test','financial-aid-rd']});
 assert.equal(retry.addedCards.length,0);assert.deepEqual(retry.alreadyPresentCardKeys,['sat-rd-test','financial-aid-rd']);
 assert.deepEqual(f.cards.filter(c=>initialIds.includes(c.id)).map(c=>c.id),initialIds);
 const later=await f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:7,cardIds:[],addedCardKeys:['rd-submit']});
 assert.equal(later.addedCards.length,1);assert.equal(later.board.templateVersion,2);
});
test('addition validation precedes changes and denies missing columns, invalid keys, capacity and actor scope',async()=>{
 let f=fixture();f.columns.splice(0);
 await assert.rejects(f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:5,cardIds:[f.cards[0].id],addedCardKeys:['rd-submit']}),/Add a board column/);assert.deepEqual(f.writes,[]);
 f=fixture();await assert.rejects(f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:5,cardIds:[],addedCardKeys:['unknown-task']}),/Select existing template task keys/);
 await assert.rejects(f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:5,cardIds:[],addedCardKeys:['rd-submit','rd-submit']}),/Select existing template task keys/);
 assert.throws(()=>templateApplySchema.parse({version:2,expectedRevision:5,cardIds:[],addedCardKeys:['rd-submit','rd-submit']}));
 assert.throws(()=>templateApplySchema.parse({version:2,expectedRevision:5,cardIds:[],addedCardKeys:['../unsafe']}));
 f=fixture();while(f.cards.length<500)f.cards.push({...f.cards[0],id:randomUUID(),template_card_key:null});
 await assert.rejects(f.service.applyTemplate(ctx,f.board.id,{version:2,expectedRevision:5,cardIds:[f.cards[0].id],addedCardKeys:['rd-submit']}),/500 active cards/);assert.deepEqual(f.writes,[]);
 f=fixture();await assert.rejects(f.service.applyTemplate({...ctx,role:'tutor',accessScope:'students',studentIds:[randomUUID()]},f.board.id,{version:2,expectedRevision:5,cardIds:[],addedCardKeys:['rd-submit']}),/Student access/);
 assert.equal(f.cards.length,2);assert.deepEqual(f.events,[]);
});
