import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Database,EventBus} from '@palladium/service-kit';
import type {RequestContext,PlatformEvent} from '@palladium/contracts';
import {AuthMailService} from '../src/auth-mail.js';
import {AuthMailDeliveryError,ResendAuthMailProvider} from '../src/auth-mail-providers.js';
import {reminderCreateSchema,reminderPatchSchema,StudentRemindersController,StudentRemindersService,reminderPath} from '../src/student-reminders.js';
import {ReminderWorker,suppressReminders} from '../src/reminder-worker.js';
import {runNotificationTicks, notificationWorkBudgetMs} from '../src/tick-budget.js';
const studentId=randomUUID(),assignmentId=randomUUID();
test('reminders accept only identifiers/time/explicit email choice; reject caller addresses, text, URLs and unbounded mutation',()=>{
 const valid={studentId,targetKind:'homework',assignmentId,remindAt:new Date(Date.now()+3600000).toISOString()};
 assert.equal(reminderCreateSchema.parse(valid).emailEnabled,false);
 for(const extra of [{email:'synthetic@example.invalid'},{title:'outbound text'},{portalUrl:'https://evil.invalid'},{businessId:randomUUID()}])assert.equal(reminderCreateSchema.safeParse({...valid,...extra}).success,false);
 assert.equal(reminderCreateSchema.safeParse({...valid,targetKind:'planning',boardId:randomUUID(),cardId:randomUUID()}).success,false);
 assert.equal(reminderPatchSchema.safeParse({action:'accepted'}).success,false);
 assert.deepEqual(Reflect.getMetadata('palladium.roles',StudentRemindersController),['student','parent']);
 assert.match(reminderPath({business_id:randomUUID(),student_id:studentId,target_kind:'homework',assignment_id:assignmentId,board_id:null,card_id:null}),new RegExp(`assignment=${assignmentId}$`));
});
test('reminder email retries use fixed Resend origin, identical payload and stable idempotency key; no live transport',async()=>{
 const calls:RequestInit[]=[];const id=randomUUID();
 const provider=new ResendAuthMailProvider('sender@example.invalid','synthetic-key',async(input,init)=>{
  assert.equal(input,'https://api.resend.com/emails');assert.equal(init?.redirect,'manual');calls.push(init!);
  return calls.length===1?new Response('',{status:429}):Response.json({id:'synthetic_accepted'});
 });
 assert.equal(await provider.sendStudentReminder({recipientEmail:'synthetic@example.invalid',reminderId:id,title:'Synthetic homework',portalUrl:'https://example.invalid/portal?student=demo'}),'synthetic_accepted');
 assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);
 assert.equal((calls[0].headers as Record<string,string>)['Idempotency-Key'],`tuts-student-reminder-${id}`);
});
test('signed resource validation fails closed on mismatched student/board, private/complete card and unavailable source',async()=>{
 const businessId=randomUUID(),boardId=randomUUID(),cardId=randomUUID();
 const ctx:RequestContext={businessId,sub:'synthetic',role:'student',accessScope:'students',studentIds:[studentId],permissions:['notifications.write','planning.read'],policyVersion:1,entitlements:['notifications','planning','clients'],requestId:randomUUID()};
 const service=new StudentRemindersService({} as Database,new AuthMailService());service.recipient=async()=> 'synthetic@example.invalid';
 const input=reminderCreateSchema.parse({studentId,targetKind:'planning',boardId,cardId,remindAt:new Date(Date.now()+3600000).toISOString()});
 const originalFetch=globalThis.fetch,urlBefore=process.env.PLANNING_URL;process.env.PLANNING_URL='http://127.0.0.1:4009';
 const base={item:{id:cardId,boardId,title:'Synthetic card',archivedAt:null,columnKind:'active'},board:{id:boardId,studentId,sharing:'student',archivedAt:null}};
 try{
  for(const [payload,status] of [
   [{...base,board:{...base.board,studentId:randomUUID()}},403],
   [{...base,item:{...base.item,boardId:randomUUID()}},404],
   [{...base,board:{...base.board,sharing:'private'}},404],
   [{...base,item:{...base.item,columnKind:'completed'}},409],
  ] as const){
   globalThis.fetch=async(_input,init)=>{assert.equal(new Headers(init!.headers).get('authorization'),'Bearer synthetic');return Response.json(payload);};
   await assert.rejects(service.create(ctx,input,'Bearer synthetic'),{status});
  }
  globalThis.fetch=async()=>new Response('',{status:503});await assert.rejects(service.create(ctx,input,'Bearer synthetic'),{status:503});
 }finally{globalThis.fetch=originalFetch;if(urlBefore===undefined)delete process.env.PLANNING_URL;else process.env.PLANNING_URL=urlBefore;}
});
test('restricted system mail rejects arbitrary paths and preserves unavailable state',async()=>{
 const before={...process.env},originalFetch=globalThis.fetch;Object.assign(process.env,{AUTH_MAIL_ENABLED:'true',AUTH_MAIL_PROVIDER:'resend',AUTH_MAIL_INTERNAL_SECRET:'s'.repeat(32),AUTH_MAIL_FROM:'sender@example.invalid',AUTH_MAIL_API_KEY:'x'.repeat(32),PUBLIC_APP_URL:'https://example.invalid'});
 try {
  const mail=new AuthMailService(),businessId=randomUUID(),id=randomUUID();
  const path=reminderPath({business_id:businessId,student_id:studentId,target_kind:'homework',assignment_id:assignmentId,board_id:null,card_id:null});
  const expected=`https://example.invalid/portal?business=${businessId}&student=${studentId}&section=homework&assignment=${assignmentId}`;
  globalThis.fetch=async (_input,init)=>{const body=JSON.parse(init!.body as string);assert.ok(body.text.includes(expected));assert.equal(new URL(expected).searchParams.get('business'),businessId);return Response.json({id:'synthetic_reminder_mail'});};
  assert.equal(await mail.sendStudentReminder({recipientEmail:'synthetic@example.invalid',reminderId:id,title:'Synthetic',portalPath:path}),'synthetic_reminder_mail');
  await assert.rejects(mail.sendStudentReminder({recipientEmail:'synthetic@example.invalid',reminderId:id,title:'Synthetic',portalPath:path.replace(businessId,'invalid-business')}),{status:400});
  await assert.rejects(mail.sendStudentReminder({recipientEmail:'synthetic@example.invalid',reminderId:id,title:'Synthetic',portalPath:path.replace(`business=${businessId}&`,'')}),{status:400});
  for(const path of ['https://evil.invalid/portal','/portal?student='+studentId+'&section=homework&assignment='+assignmentId+'&url=https://evil.invalid','/portal?student='+studentId+'&section=homework&assignment='+assignmentId+'#secret'])await assert.rejects(mail.sendStudentReminder({recipientEmail:'synthetic@example.invalid',reminderId:randomUUID(),title:'Synthetic',portalPath:path}),{status:400});
  process.env.AUTH_MAIL_ENABLED='false';assert.equal(mail.status().available,false);
 }finally{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);}
});
test('Cloudflare reminder worker registers proven terminal events and has no timer',()=>{
 const previous=process.env.TUTS_RUNTIME;process.env.TUTS_RUNTIME='cloudflare';
 try{const types:string[]=[];const worker=new ReminderWorker({} as Database,{subscribe(type:string){types.push(type);}} as EventBus,new AuthMailService());worker.onModuleInit();assert.deepEqual(types,['learning.assignment-reviewed.v1','planning.board-updated.v1','planning.card-updated.v1','platform.portal-access-revoked.v1']);assert.equal((worker as unknown as {interval:unknown}).interval,undefined);}finally{if(previous===undefined)delete process.env.TUTS_RUNTIME;else process.env.TUTS_RUNTIME=previous;}
});
test('scheduled queues alternate priority and share one monotonic work deadline below gateway timeout',async()=>{
 for(const [wallTime,expected] of [[0,['reminders','campaigns']],[15*60_000,['campaigns','reminders']]] as const){
  const before=performance.now(),calls:{queue:string;deadline:number}[]=[];
  await runNotificationTicks({tick:async deadline=>{calls.push({queue:'campaigns',deadline});}},{tick:async deadline=>{calls.push({queue:'reminders',deadline});}},wallTime);
  assert.deepEqual(calls.map(call=>call.queue),expected);assert.equal(calls[0].deadline,calls[1].deadline);
  assert.ok(calls[0].deadline>=before+notificationWorkBudgetMs);assert.ok(calls[0].deadline<before+30_000);
 }
});
const dbAvailable=Boolean(process.env.NOTIFICATIONS_TEST_DATABASE_URL);
test('ordinary role reminders isolate account/tenant/student, due inbox works without sender, bounded state and duplicate schedules', {skip:!dbAvailable},async()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL=process.env.NOTIFICATIONS_TEST_DATABASE_URL;const db=new Database();if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
 const businessId=randomUUID();const ctx:RequestContext={businessId,sub:'synthetic-student',role:'student',accessScope:'students',studentIds:[studentId],permissions:['notifications.read','notifications.write','learning.read'],policyVersion:1,entitlements:['notifications','learning','clients'],requestId:randomUUID()};
 const other={...ctx,sub:'other-synthetic-account'};
 const service=new StudentRemindersService(db,{status:()=>({available:false})} as AuthMailService);service.recipient=async()=> 'synthetic@example.invalid';
 const fetchBefore=globalThis.fetch;const urlBefore=process.env.LEARNING_URL;process.env.LEARNING_URL='http://127.0.0.1:4004';
 globalThis.fetch=async()=>Response.json({item:{id:assignmentId,clientId:studentId,title:'Synthetic homework',status:'assigned'}});
 try{
  const role=(await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  await db.migrate(fileURLToPath(new URL('../migrations',import.meta.url)));
  const input=reminderCreateSchema.parse({studentId,targetKind:'homework',assignmentId,remindAt:new Date(Date.now()+3600000).toISOString()});
  const created=await service.create(ctx,input,'Bearer synthetic');assert.equal(created.item.emailEnabled,false);
  await assert.rejects(service.create(ctx,input,'Bearer synthetic'),{status:409});
  await assert.rejects(service.create({...ctx,studentIds:[]},input,'Bearer synthetic'),{status:403});
  assert.equal((await service.list(other,{studentId,limit:50,offset:0})).total,0);
  await assert.rejects(service.patch(other,created.item.id,{action:'cancel'}),{status:404});
  await assert.rejects(service.patch({...ctx,businessId:randomUUID()},created.item.id,{action:'cancel'}),{status:404});
  await assert.rejects(service.patch(ctx,created.item.id,{action:'read'}),{status:409});
  await db.withTenant(businessId,tx=>tx.query("UPDATE student_reminders SET remind_at=now()-interval '1 minute' WHERE id=$1",[created.item.id]));
  const list=await service.list(ctx,{studentId,limit:50,offset:0});assert.equal(list.items[0].state,'due');assert.equal(list.items[0].emailStatus,'disabled');assert.equal(list.emailAvailable,false);
  assert.equal((await service.patch(ctx,created.item.id,{action:'read'})).item.state,'read');await assert.rejects(service.patch(ctx,created.item.id,{action:'cancel'}),{status:409});
  assert.equal((await db.pool.query('SELECT * FROM student_reminders WHERE id=$1',[created.item.id])).rowCount,0);
  await db.withTenant(randomUUID(),async tx=>{await assert.rejects(tx.query("INSERT INTO student_reminders(id,business_id,user_id,student_id,target_kind,assignment_id,title,remind_at) VALUES($1,$2,'synthetic',$3,'homework',$4,'Synthetic',now())",[randomUUID(),businessId,studentId,assignmentId]),(error:unknown)=>(error as {code:string}).code==='42501');});
 }finally{
  globalThis.fetch=fetchBefore;if(urlBefore===undefined)delete process.env.LEARNING_URL;else process.env.LEARNING_URL=urlBefore;
  await db.withTenant(businessId,async tx=>{await tx.query('DELETE FROM student_reminder_attempts WHERE business_id=$1',[businessId]);await tx.query('DELETE FROM student_reminders WHERE business_id=$1',[businessId]);});await db.pool.query('DELETE FROM notification_reminder_directory WHERE business_id=$1',[businessId]);await db.pool.end();
 }
});
test('duplicate ticks lease once; revoked access suppresses; provider ambiguity and expired leases never resend; terminal events are scoped',{skip:!dbAvailable},async()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL=process.env.NOTIFICATIONS_TEST_DATABASE_URL;const db=new Database();if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
 const businessId=randomUUID(),userId='synthetic-worker';let sends=0;
 const mail={status:()=>({available:true}),sendStudentReminder:async()=>{sends++;return 'synthetic_provider';}} as unknown as AuthMailService;
 const worker=new ReminderWorker(db,{} as EventBus,mail);worker.recipient=async()=> 'synthetic@example.invalid';
 const insert=async()=>db.withTenant(businessId,async tx=>(await tx.query<{id:string}>("INSERT INTO student_reminders(id,business_id,user_id,student_id,target_kind,assignment_id,title,remind_at,email_enabled,email_status) VALUES($1,$2,$3,$4,'homework',$5,'Synthetic',now()-interval '1 minute',true,'pending') RETURNING id",[randomUUID(),businessId,userId,studentId,randomUUID()])).rows[0].id);
 const state=async(id:string)=>db.withTenant(businessId,async tx=>(await tx.query('SELECT * FROM student_reminders WHERE id=$1',[id])).rows[0]);
 try{
  await db.migrate(fileURLToPath(new URL('../migrations',import.meta.url)));
  const accepted=await insert();await Promise.all([worker.processTenant(businessId),worker.processTenant(businessId)]);assert.equal(sends,1);assert.equal((await state(accepted)).email_status,'accepted');
  const revoked=await insert();worker.recipient=async()=>{const {ForbiddenException}=await import('@nestjs/common');throw new ForbiddenException();};await worker.processTenant(businessId);assert.equal(sends,1);assert.equal((await state(revoked)).email_status,'suppressed');
  const ambiguous=await insert();worker.recipient=async()=> 'synthetic@example.invalid';mail.sendStudentReminder=async()=>{sends++;throw new AuthMailDeliveryError(true,'timeout');};await worker.processTenant(businessId);await worker.processTenant(businessId);assert.equal(sends,2);assert.equal((await state(ambiguous)).email_status,'unknown');
  const expired=await insert();await db.withTenant(businessId,async tx=>{const token=randomUUID();await tx.query("UPDATE student_reminders SET email_status='sending',lease_token=$2,lease_until=now()-interval '1 minute' WHERE id=$1",[expired,token]);await tx.query("INSERT INTO student_reminder_attempts(id,business_id,reminder_id,idempotency_key,status) VALUES($1,$2,$3,'synthetic','sending')",[token,businessId,expired]);});await worker.processTenant(businessId);assert.equal(sends,2);assert.equal((await state(expired)).email_reason,'lease_expired_acceptance_unknown');
  const closed=await insert(),row=await state(closed);const event:PlatformEvent={id:randomUUID(),type:'learning.assignment-reviewed.v1',producer:'learning',version:1,businessId,occurredAt:new Date(Date.now()+1000).toISOString(),correlationId:randomUUID(),data:{studentId,assignmentId:row.assignment_id,revision:2,status:'needs_revision'}};
  await db.withTenant(businessId,tx=>suppressReminders(event,tx));assert.equal((await state(closed)).state,'scheduled');
  event.data.status='completed';await db.withTenant(businessId,tx=>suppressReminders(event,tx));assert.equal((await state(closed)).state,'cancelled');assert.equal((await state(closed)).email_status,'suppressed');
  const deferred=await insert();const sendsBeforeBudget=sends;
  await worker.processTenant(businessId,performance.now()+1000);
  assert.equal((await state(deferred)).email_status,'pending');assert.equal(sends,sendsBeforeBudget);
  // Recheck after private authorization: provider work must not start if time
  // consumed by prior SQL/private validation leaves less than its full budget.
  const oldNow=Object.getOwnPropertyDescriptor(performance,'now');let simulatedNow=1000;
  Object.defineProperty(performance,'now',{value:()=>simulatedNow,configurable:true});
  worker.recipient=async()=>{simulatedNow+=12_000;return 'synthetic@example.invalid';};
  try{
   await worker.processTenant(businessId,23_000);assert.equal((await state(deferred)).email_status,'pending');assert.equal(sends,sendsBeforeBudget);
   // Two seconds spent before tenant processing must still leave a usable
   // lease margin; a 21s reserve under the 22s tick would starve this case.
   simulatedNow=3000;worker.recipient=async()=> 'synthetic@example.invalid';mail.sendStudentReminder=async()=>{sends++;return 'synthetic_budget_accepted';};
   await worker.processTenant(businessId,23_000);assert.equal((await state(deferred)).email_status,'accepted');assert.equal(sends,sendsBeforeBudget+1);
  }finally{if(oldNow)Object.defineProperty(performance,'now',oldNow);else delete (performance as unknown as Record<string,unknown>).now;worker.recipient=async()=> 'synthetic@example.invalid';}
  await db.withTenant(businessId,tx=>tx.query("UPDATE student_reminders SET state='cancelled' WHERE id=$1",[deferred]));
  const card=await insert(),boardId=randomUUID(),cardId=randomUUID();await db.withTenant(businessId,tx=>tx.query("UPDATE student_reminders SET target_kind='planning',assignment_id=NULL,board_id=$2,card_id=$3 WHERE id=$1",[card,boardId,cardId]));
  const cardEvent={...event,type:'planning.card-updated.v1',producer:'planning',data:{studentId,boardId,cardId,archived:false,sharing:'student',completed:false,revision:2}};
  await db.withTenant(businessId,tx=>suppressReminders(cardEvent,tx));assert.equal((await state(card)).state,'scheduled');cardEvent.data.completed=true;await db.withTenant(businessId,tx=>suppressReminders(cardEvent,tx));assert.equal((await state(card)).state,'cancelled');
  await db.withTenant(randomUUID(),async tx=>{await assert.rejects(tx.query("INSERT INTO student_reminder_attempts(id,business_id,reminder_id,idempotency_key,status) VALUES($1,$2,$3,'synthetic','sending')",[randomUUID(),businessId,accepted]),(error:unknown)=>(error as {code:string}).code==='42501');});
  const tenantB=randomUUID();await db.withTenant(tenantB,async tx=>{await assert.rejects(tx.query("INSERT INTO student_reminder_attempts(id,business_id,reminder_id,idempotency_key,status) VALUES($1,$2,$3,'synthetic','sending')",[randomUUID(),tenantB,accepted]),(error:unknown)=>(error as {code:string}).code==='23503');});

 }finally{await db.withTenant(businessId,async tx=>{await tx.query('DELETE FROM student_reminder_attempts WHERE business_id=$1',[businessId]);await tx.query('DELETE FROM student_reminders WHERE business_id=$1',[businessId]);});await db.pool.end();}
});
