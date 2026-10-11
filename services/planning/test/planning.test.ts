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
  assert.equal((await get({...f.ctx,permissions:[]},`/v1/overview?studentId=${f.student}`)).status,403);
  assert.equal((await get(f.ctx,'/v1/overview')).status,400);
  assert.equal((await get(f.ctx,'/v1/overview?studentId=invalid')).status,400);
  const learner={...f.ctx,sub:'synthetic-student',role:'student' as const,accessScope:'students' as const,studentIds:[f.student],permissions:['planning.read','planning.write','clients.read']};
  assert.equal((await get(learner,`/v1/boards/${board.item.id}`)).status,404);assert.equal((await get(learner,`/v1/boards/${shared.item.id}`)).status,200);
  assert.equal((await get({...learner,studentIds:[randomUUID()]},`/v1/boards/${shared.item.id}`)).status,403);
  assert.equal((await get(learner,`/v1/overview?studentId=${f.student}`)).status,200);
  assert.equal((await get({...learner,studentIds:[randomUUID()]},`/v1/overview?studentId=${f.student}`)).status,403);
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

test('overview bounds lists independently of totals and enforces tenant, student, canonical and archive visibility',{skip:!enabled},async()=>{
 const f=await fixture();try{
  const ids=Array.from({length:25},()=>randomUUID()),columns=ids.map(()=>randomUUID()),otherStudent=randomUUID(),alias=randomUUID();
  await f.db.withTenant(f.ctx.businessId,async tx=>{
   await tx.query('INSERT INTO planning_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,1)',[f.ctx.businessId,alias,f.student]);
   for(let i=0;i<ids.length;i++){
    await tx.query(`INSERT INTO planning_boards(id,business_id,student_id,name,sharing,created_by,archived_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[ids[i],f.ctx.businessId,i===24?otherStudent:i===0?alias:f.student,`Synthetic ${i}`,i===22?'private':'student',f.ctx.sub,i===23?new Date():null]);
    await tx.query('INSERT INTO planning_columns(id,business_id,board_id,name,position) VALUES($1,$2,$3,$4,0)',[columns[i],f.ctx.businessId,ids[i],'To do']);
    await tx.query(`INSERT INTO planning_cards(id,business_id,board_id,column_id,title,position,created_by) VALUES($1,$2,$3,$4,'Synthetic task',0,$5)`,[randomUUID(),f.ctx.businessId,ids[i],columns[i],f.ctx.sub]);
   }
   for(let i=0;i<12;i++)await tx.query(`INSERT INTO planning_cards(id,business_id,board_id,column_id,title,position,created_by,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,jsonb_build_object('dueAt',now()+($8::integer*interval '1 day')))`,[randomUUID(),f.ctx.businessId,ids[0],columns[0],`Dated task ${i}`,i+1,f.ctx.sub,i===0?-1:i<7?i:30+i]);
   for(const name of ['Review','Done']){const column=randomUUID();await tx.query('INSERT INTO planning_columns(id,business_id,board_id,name,position) VALUES($1,$2,$3,$4,1)',[column,f.ctx.businessId,ids[0],name]);await tx.query(`INSERT INTO planning_cards(id,business_id,board_id,column_id,title,position,created_by,deadline) VALUES($1,$2,$3,$4,$5,0,$6,jsonb_build_object('dueAt',now()+interval '1 day'))`,[randomUUID(),f.ctx.businessId,ids[0],column,name,f.ctx.sub]);}
   await tx.query(`INSERT INTO planning_cards(id,business_id,board_id,column_id,title,position,created_by,archived_at) VALUES($1,$2,$3,$4,'Archived task',99,$5,now())`,[randomUUID(),f.ctx.businessId,ids[0],columns[0],f.ctx.sub]);
  });
  const learner={...f.ctx,role:'student' as const,sub:'synthetic-learner',accessScope:'students' as const,studentIds:[f.student],permissions:['planning.read']};
  await f.db.withTenant(f.ctx.businessId,async tx=>{
   await tx.query("SET LOCAL TIME ZONE 'America/New_York'");
   const window=(await tx.query("SELECT extract(epoch FROM (t+interval '168 hours')-t)::integer seconds FROM (SELECT '2027-03-12T12:00:00-05:00'::timestamptz t) v")).rows[0];
   assert.equal(window.seconds,7*24*3600);
  });
  const overview=await f.service.overview(learner,{studentId:f.student});
  assert.deepEqual(overview.summary,{total:36,pending:34,inProgress:1,completed:1,overdue:1,dueSoon:7});
  assert.equal(overview.tasks.length,10);assert.equal(overview.upcomingTasks.length,5);assert.equal(overview.boards.length,20);assert.equal(overview.dueSoonDays,7);assert.equal(overview.tasks[0].title,'Dated task 0');assert.ok(['Dated task 1','Review'].includes(overview.upcomingTasks[0].title));
  assert.ok(overview.upcomingTasks.every((t:any)=>t.columnKind!=='completed'&&new Date(t.deadline.dueAt).getTime()>=Date.now()-1000));
  assert.ok(overview.tasks.every((t:any)=>t.columnKind!=='completed'));assert.ok(overview.boards.every((b:any)=>!ids.slice(22).includes(b.id)));
  assert.deepEqual((await f.service.overview(f.ctx,{studentId:f.student})).summary,overview.summary);
  assert.equal((await f.service.overview({...f.ctx,businessId:randomUUID()},{studentId:f.student})).summary.total,0);
  assert.deepEqual((await f.service.overview({...f.ctx,businessId:randomUUID()},{studentId:f.student})).upcomingTasks,[]);
  await f.db.withTenant(f.ctx.businessId,async tx=>{for(let i=0;i<15;i++)await tx.query(`INSERT INTO planning_cards(id,business_id,board_id,column_id,title,position,created_by,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,jsonb_build_object('dueAt',now()-interval '1 day'))`,[randomUUID(),f.ctx.businessId,ids[0],columns[0],`Overdue backlog ${i}`,100+i,f.ctx.sub]);});
  const backlog=await f.service.overview(learner,{studentId:f.student});assert.equal(backlog.summary.total,51);assert.equal(backlog.summary.overdue,16);assert.ok(backlog.tasks.every((t:any)=>new Date(t.deadline.dueAt).getTime()<Date.now()));assert.deepEqual(backlog.upcomingTasks,overview.upcomingTasks);
  await assert.rejects(f.service.overview({...learner,studentIds:[otherStudent]},{studentId:f.student}),/Student access/);
  await assert.rejects(f.service.overview({...learner,studentIds:[alias]},{studentId:alias}),/Student access/);
  assert.equal((await f.service.overview(f.ctx,{studentId:alias})).studentId,f.student);
 }finally{await f.cleanup();}
});

test('reviewed resources persist additively and capacity failure rolls back a simultaneous date update',{skip:!enabled},async()=>{
 const f=await fixture();try{
  const key=`custom-${randomUUID()}`,base={key,name:'Synthetic resource template',cycle:2027,country:'GB',applicantCategory:'undergraduate',program:'synthetic',round:'synthetic',applicability:'Synthetic only',columns:['To do'],cards:[{key:'essay',columnIndex:0,title:'Essay'}]};
  await f.service.createTemplate(f.ctx,schema.customTemplateSchema.parse(base));
  const board=await f.service.instantiate(f.ctx,key,schema.instantiateSchema.parse({studentId:f.student,version:1,idempotencyKey:randomUUID(),applicabilityConfirmed:true,applicability:{cycle:2027,country:'GB',applicantCategory:'undergraduate',program:'synthetic',round:'synthetic'},sharing:'student'}),'Bearer fixture');
  const card=board.cards[0]!,manualStep={id:randomUUID(),text:'Manual done',done:true},manualRef={kind:'link',label:'Manual source',url:'https://example.com/Manual'};
  await f.service.updateCard(f.ctx,card.id,schema.cardUpdateSchema.parse({expectedRevision:1,title:'Personal essay',checklist:[manualStep],references:[manualRef]}));
  const newStep={id:randomUUID(),text:'Review essay',done:false},newRef={kind:'link',label:'Official guide',url:'https://www.commonapp.org/apply/first-year-students/'};
  await f.service.createTemplate(f.ctx,schema.customTemplateSchema.parse({...base,cards:[{...base.cards[0],checklist:[newStep],references:[newRef],deadline:{kind:'personal',dueAt:'2027-01-02T12:00:00Z',timeZone:'UTC'}}]}));
  const reviewed=await f.service.reviewTemplate(f.ctx,board.item.id,2);assert.equal(reviewed.resourceSuggestions.length,1);assert.deepEqual((await f.service.cardDetail(f.ctx,card.id)).item.references,[manualRef]);
  await f.service.applyTemplate(f.ctx,board.item.id,{version:2,expectedRevision:2,cardIds:[],resourceCardIds:[card.id]});
  const saved=(await f.service.cardDetail(f.ctx,card.id)).item;assert.equal(saved.title,'Personal essay');assert.deepEqual(saved.checklist,[manualStep,newStep]);assert.deepEqual(saved.references,[manualRef,newRef]);assert.equal(saved.deadline,null);
  await f.service.applyTemplate(f.ctx,board.item.id,{version:2,expectedRevision:3,cardIds:[],resourceCardIds:[card.id]});assert.deepEqual((await f.service.cardDetail(f.ctx,card.id)).item,saved);
  const fullRefs=Array.from({length:30},(_,i)=>({kind:'link',label:`Manual ${i}`,url:`https://example.com/${i}`}));
  await f.service.updateCard(f.ctx,card.id,schema.cardUpdateSchema.parse({expectedRevision:saved.revision,references:fullRefs}));
  const before=(await f.service.cardDetail(f.ctx,card.id)).item;
  await assert.rejects(f.service.applyTemplate(f.ctx,board.item.id,{version:2,expectedRevision:5,cardIds:[card.id],resourceCardIds:[card.id]}),/exceeds card limits/);
  assert.deepEqual((await f.service.cardDetail(f.ctx,card.id)).item,before);assert.equal((await f.service.boardDetail(f.ctx,board.item.id)).item.revision,5);
 }finally{await f.cleanup();}
});

test('Campus France corrected source wall time requires explicit v4 review and preserves edited dates',{skip:!enabled},async()=>{
 const f=await fixture();try{
  const key='campus-france-maroc-2027',input=schema.instantiateSchema.parse({studentId:f.student,version:3,idempotencyKey:randomUUID(),applicabilityConfirmed:true,applicability:{cycle:2027,country:'FR',applicantCountry:'MA',applicantCategory:'morocco_procedure',program:'etudes_en_france_connected_or_dap',round:'2026_27_procedure'},sharing:'student'});
  const board=await f.service.instantiate(f.ctx,key,input,'Bearer fixture'),submit=board.cards.find(c=>c.templateCardKey==='submit')!;
  assert.equal(submit.deadline.dueAt,'2026-11-15T22:59:00Z');
  const review=await f.service.reviewTemplate(f.ctx,board.item.id,4);assert.equal(review.suggestions.length,1);assert.deepEqual(review.resourceSuggestions,[]);assert.equal(review.suggestions[0].proposedDeadline.dueAt,'2026-11-15T23:59:00Z');
  assert.equal((await f.service.cardDetail(f.ctx,submit.id)).item.deadline.dueAt,'2026-11-15T22:59:00Z');
  await f.service.applyTemplate(f.ctx,board.item.id,{version:4,expectedRevision:1,cardIds:[submit.id]});assert.equal((await f.service.cardDetail(f.ctx,submit.id)).item.deadline.dueAt,'2026-11-15T23:59:00Z');
  const edited=await f.service.instantiate(f.ctx,key,{...input,idempotencyKey:randomUUID()},'Bearer fixture'),manualSubmit=edited.cards.find(c=>c.templateCardKey==='submit')!;
  await f.service.updateCard(f.ctx,manualSubmit.id,schema.cardUpdateSchema.parse({expectedRevision:1,deadline:{kind:'personal',dueAt:'2026-11-10T12:00:00Z',timeZone:'Africa/Casablanca'}}));
  const saved=(await f.service.cardDetail(f.ctx,manualSubmit.id)).item.deadline;
  const applied=await f.service.applyTemplate(f.ctx,edited.item.id,{version:4,expectedRevision:2,cardIds:[manualSubmit.id]});assert.deepEqual(applied.preservedCardIds,[manualSubmit.id]);assert.deepEqual((await f.service.cardDetail(f.ctx,manualSubmit.id)).item.deadline,saved);
 }finally{await f.cleanup();}
});
