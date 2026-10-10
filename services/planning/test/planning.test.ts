import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from 'node:http';
import {Database,createServiceApplication} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {PlanningService} from '../src/planning.service.js';
import {PlanningController} from '../src/planning.controller.js';
import * as schema from '../src/schemas.js';
const enabled=Boolean(process.env.PLANNING_TEST_DATABASE_URL);
const fixture=async()=>{
 const old={DATABASE_URL:process.env.DATABASE_URL,CLIENTS_URL:process.env.CLIENTS_URL,DISABLE_BROKER:process.env.DISABLE_BROKER,CONTEXT_PUBLIC_KEY:process.env.CONTEXT_PUBLIC_KEY};
 process.env.DATABASE_URL=process.env.PLANNING_TEST_DATABASE_URL;process.env.DISABLE_BROKER='true';
 const db=new Database(),service=new PlanningService(db),student=randomUUID();
 const ctx:RequestContext={businessId:randomUUID(),sub:`synthetic-${randomUUID()}`,role:'owner',entitlements:['planning','clients'],requestId:randomUUID(),policyVersion:1,accessScope:'business',studentIds:[],permissions:['planning.read','planning.write','clients.read']};
 const source=createServer((req,res)=>{if(req.url===`/v1/portal/students/${student}`&&req.headers.authorization){res.setHeader('content-type','application/json');res.end(JSON.stringify({item:{id:student}}));}else{res.statusCode=404;res.end('{}');}});
 await new Promise<void>(resolve=>source.listen(0,'127.0.0.1',resolve));const address=source.address();assert.ok(address&&typeof address==='object');process.env.CLIENTS_URL=`http://127.0.0.1:${address.port}`;
 assert.deepEqual((await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],{rolsuper:false,rolbypassrls:false});
 const cleanup=async()=>{
  await db.withTenant(ctx.businessId,async tx=>{await tx.query('DELETE FROM planning_instantiations');await tx.query('DELETE FROM planning_boards');await tx.query('DELETE FROM planning_templates');await tx.query('DELETE FROM planning_student_aliases');});
  await db.pool.query("DELETE FROM service_outbox WHERE event->>'businessId'=$1",[ctx.businessId]);await db.pool.end();await new Promise<void>((resolve,reject)=>source.close(error=>error?reject(error):resolve()));
  for(const [key,value] of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 };
 return {db,service,student,ctx,cleanup};
};
test('ordinary-role Planning isolates tenants and enforces private/student sharing and capability at HTTP boundary',{skip:!enabled},async()=>{
 const f=await fixture();const keys=generateKeyPairSync('ed25519');process.env.CONTEXT_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'}).toString();let app:Awaited<ReturnType<typeof createServiceApplication>>|undefined;
 try{
  const board=await f.service.createBoard(f.ctx,schema.boardCreateSchema.parse({studentId:f.student,name:'Synthetic private'}),'Bearer fixture');
  await assert.rejects(f.service.boardDetail({...f.ctx,businessId:randomUUID()},board.item.id),/Board not found/);
  const shared=await f.service.createBoard(f.ctx,schema.boardCreateSchema.parse({studentId:f.student,name:'Synthetic shared',sharing:'student'}),'Bearer fixture');
  app=await createServiceApplication({name:'planning',port:0,entitlement:'planning',controllers:[PlanningController],providers:[PlanningService],migrationsDir:''},false);await app.listen(0,'127.0.0.1');const origin=await app.getUrl();
  const token=(ctx:RequestContext)=>{const now=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'JWT'})).toString('base64url'),body=Buffer.from(JSON.stringify({...ctx,iss:'palladium-gateway',aud:'palladium-services',iat:now,exp:now+60})).toString('base64url');return `${header}.${body}.${sign(null,Buffer.from(`${header}.${body}`),keys.privateKey).toString('base64url')}`;};
  const get=(ctx:RequestContext,path:string,method='GET',body?:unknown)=>fetch(`${origin}${path}`,{method,headers:{authorization:`Bearer ${token(ctx)}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await get({...f.ctx,entitlements:['clients']},'/v1/boards')).status,403);
  assert.equal((await get({...f.ctx,permissions:[]},'/v1/boards')).status,403);
  const learner={...f.ctx,sub:'synthetic-student',role:'student' as const,accessScope:'students' as const,studentIds:[f.student],permissions:['planning.read','planning.write','clients.read']};
  assert.equal((await get(learner,`/v1/boards/${board.item.id}`)).status,404);assert.equal((await get(learner,`/v1/boards/${shared.item.id}`)).status,200);
  assert.equal((await get({...learner,studentIds:[randomUUID()]},`/v1/boards/${shared.item.id}`)).status,403);
  const parent={...learner,role:'parent' as const,permissions:['planning.read']};assert.equal((await get(parent,`/v1/boards/${shared.item.id}`,'PATCH',{expectedRevision:1,name:'Forbidden'})).status,403);
  const unrelatedTutor={...f.ctx,sub:'synthetic-other-tutor',role:'tutor' as const};assert.equal((await get(unrelatedTutor,`/v1/boards/${shared.item.id}`,'PATCH',{expectedRevision:1,name:'Forbidden'})).status,403);
  const list=await (await get(learner,'/v1/boards')).json() as {items:{id:string}[]};assert.deepEqual(list.items.map(row=>row.id),[shared.item.id]);
 }finally{if(app)await app.close();await f.cleanup();}
});
test('concurrent card and column reorders preserve optimistic board/card revisions with explicit retry',{skip:!enabled},async()=>{
 const f=await fixture();try{
  const board=await f.service.createBoard(f.ctx,schema.boardCreateSchema.parse({studentId:f.student,name:'Synthetic order',sharing:'student'}),'Bearer fixture');const [first,second]=board.columns;
  const a=await f.service.createCard(f.ctx,board.item.id,schema.cardCreateSchema.parse({title:'A',columnId:first!.id,position:0,expectedBoardRevision:1}));
  const b=await f.service.createCard(f.ctx,board.item.id,schema.cardCreateSchema.parse({title:'B',columnId:first!.id,position:1,expectedBoardRevision:2}));
  const cards=[a.item,b.item];const moved=await Promise.allSettled(cards.map((card,index)=>f.service.moveCard(f.ctx,card.id,{columnId:second!.id,position:index,expectedRevision:1,expectedBoardRevision:3})));
  assert.equal(moved.filter(result=>result.status==='fulfilled').length,1);const rejected=moved.findIndex(result=>result.status==='rejected');assert.match(String((moved[rejected] as PromiseRejectedResult).reason),/Board changed/);
  await f.service.moveCard(f.ctx,cards[rejected]!.id,{columnId:second!.id,position:rejected,expectedRevision:1,expectedBoardRevision:4});
  const detail=await f.service.boardDetail(f.ctx,board.item.id);assert.equal(detail.item.revision,5);assert.ok(detail.cards.every(card=>card.columnId===second!.id&&card.revision===2));
  const reordered=await Promise.allSettled([f.service.updateColumn(f.ctx,board.item.id,first!.id,{position:2,expectedRevision:1,expectedBoardRevision:5}),f.service.updateColumn(f.ctx,board.item.id,second!.id,{position:-1,expectedRevision:1,expectedBoardRevision:5})]);assert.equal(reordered.filter(result=>result.status==='fulfilled').length,1);assert.match(String((reordered.find(result=>result.status==='rejected') as PromiseRejectedResult).reason),/Board changed/);
  const outbox=await f.db.pool.query("SELECT count(*) count FROM service_outbox WHERE event->>'businessId'=$1",[f.ctx.businessId]);assert.ok(Number(outbox.rows[0].count)>=10);
 }finally{await f.cleanup();}
});
test('template instantiation retries are idempotent; updates preserve edited deadlines and require explicit added task selection',{skip:!enabled},async()=>{
 const f=await fixture();try{
  const key=`custom-${randomUUID()}`,deadline={kind:'personal',dueAt:'2027-02-01T12:00:00Z',timeZone:'UTC'},definition={key,name:'Synthetic template',cycle:2027,country:'GB',applicantCategory:'undergraduate',program:'synthetic',round:'synthetic',applicability:'Synthetic only',columns:['To do'],cards:[{key:'essay',columnIndex:0,title:'Essay',deadline}]};
  await f.service.createTemplate(f.ctx,schema.customTemplateSchema.parse(definition));
  const input=schema.instantiateSchema.parse({studentId:f.student,version:1,idempotencyKey:`fixture-${randomUUID()}`,applicabilityConfirmed:true,applicability:{cycle:2027,country:'GB',applicantCategory:'undergraduate',program:'synthetic',round:'synthetic'},sharing:'student'});
  const results=await Promise.all([f.service.instantiate(f.ctx,key,input,'Bearer fixture'),f.service.instantiate(f.ctx,key,input,'Bearer fixture')]);assert.equal(results[0]!.item.id,results[1]!.item.id);assert.equal(results.filter(result=>result.replayed).length,1);
  await assert.rejects(f.service.instantiate(f.ctx,key,{...input,name:'Different'},'Bearer fixture'),/Idempotency key/);
  const board=results[0]!,card=board.cards[0]!;assert.equal(card.deadline.status,'user_set');const personal={...deadline,dueAt:'2027-01-25T12:00:00Z'};
  await f.service.updateCard(f.ctx,card.id,schema.cardUpdateSchema.parse({expectedRevision:1,title:'My edited essay',deadline:personal}));
  await f.service.createTemplate(f.ctx,schema.customTemplateSchema.parse({...definition,cards:[{...definition.cards[0],deadline:{kind:'official',dueAt:'2027-03-01T12:00:00Z',timeZone:'UTC',sourceUrls:['https://example.org/official']}},{key:'reference',columnIndex:0,title:'Request reference'}]}));
  const review=await f.service.reviewTemplate(f.ctx,board.item.id,2);assert.equal(review.automaticApply,false);assert.equal(review.suggestions[0]!.preserveUserEdit,true);assert.equal(review.suggestions[0]!.proposedDeadline.status,'requires_confirmation');assert.equal(review.addedCards.length,1);
  const applied=await f.service.applyTemplate(f.ctx,board.item.id,{version:2,expectedRevision:2,cardIds:[card.id],addedCardKeys:['reference']});assert.deepEqual(applied.preservedCardIds,[card.id]);assert.equal(applied.addedCards.length,1);
  const retry=await f.service.applyTemplate(f.ctx,board.item.id,{version:2,expectedRevision:3,cardIds:[],addedCardKeys:['reference']});assert.equal(retry.addedCards.length,0);assert.deepEqual(retry.alreadyPresentCardKeys,['reference']);
  const final=await f.service.cardDetail(f.ctx,card.id);assert.equal(final.item.title,'My edited essay');assert.equal(final.item.deadline.dueAt,personal.dueAt);
  const original=await f.service.templateDetail(f.ctx,key,1);assert.equal(original.item.definition.cards[0].deadline.dueAt,deadline.dueAt);
 }finally{await f.cleanup();}
});
