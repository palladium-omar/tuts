import {randomUUID} from 'node:crypto';
import {BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, Inject, Injectable, NotFoundException, Param, Patch, Post, Query, ServiceUnavailableException} from '@nestjs/common';
import {assertPermission, assertStudentAccess, CurrentContext, Database, emitEvent, parseBody, Permissions, Roles, serviceFetch, StudentScoped} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {z} from 'zod';
import {AuthMailService} from './auth-mail.js';
const base={studentId:z.uuid(),remindAt:z.iso.datetime({offset:true}),emailEnabled:z.boolean().default(false)};
export const reminderCreateSchema=z.discriminatedUnion('targetKind',[
 z.object({...base,targetKind:z.literal('homework'),assignmentId:z.uuid()}).strict(),
 z.object({...base,targetKind:z.literal('planning'),boardId:z.uuid(),cardId:z.uuid()}).strict(),
]);
export const reminderListSchema=z.object({studentId:z.uuid(),limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export const reminderPatchSchema=z.object({action:z.enum(['read','cancel'])}).strict();
export type ReminderInput=z.infer<typeof reminderCreateSchema>;
export type ReminderRow={id:string;business_id:string;user_id:string;student_id:string;target_kind:'homework'|'planning';assignment_id:string|null;board_id:string|null;card_id:string|null;title:string;remind_at:Date;state:'scheduled'|'due'|'read'|'cancelled';email_enabled:boolean;email_status:string;email_reason:string|null;provider_message_id:string|null;lease_token:string|null;lease_until:Date|null;created_at:Date;read_at:Date|null;cancelled_at:Date|null};
export function reminderPath(row:Pick<ReminderRow,'business_id'|'student_id'|'target_kind'|'assignment_id'|'board_id'|'card_id'>){
 const query=new URLSearchParams({business:row.business_id,student:row.student_id,section:row.target_kind==='homework'?'homework':'planning'});
 if(row.target_kind==='homework')query.set('assignment',row.assignment_id!);
 else {query.set('board',row.board_id!);query.set('card',row.card_id!);}
 return `/portal?${query}`;
}
export function reminderItem(row:ReminderRow){return {id:row.id,studentId:row.student_id,targetKind:row.target_kind,assignmentId:row.assignment_id,boardId:row.board_id,cardId:row.card_id,title:row.title,portalPath:reminderPath(row),remindAt:row.remind_at,state:row.state,emailEnabled:row.email_enabled,emailStatus:row.email_status,emailReason:row.email_reason,createdAt:row.created_at,readAt:row.read_at,cancelledAt:row.cancelled_at};}
/** Resolve current identity/grant at every inbox operation and delivery. No address is persisted. */
export async function resolveReminderRecipient(input:{businessId:string;userId:string;studentId:string;targetKind?:'homework'|'planning';operation:'read'|'write'|'delivery'}):Promise<string>{
 const secret=process.env.AUTH_MAIL_INTERNAL_SECRET??'';
 if(!/^[A-Za-z0-9+/_=-]{32,512}$/.test(secret))throw new ServiceUnavailableException('Reminder access validation is unavailable');
 try {
  const response=await serviceFetch('platform','/internal/reminder-recipient',{method:'POST',headers:{'Content-Type':'application/json','X-Auth-Mail-Secret':secret},body:JSON.stringify(input),signal:AbortSignal.timeout(8000)});
  if(response.status===403||response.status===404)throw new ForbiddenException('Reminder access is unavailable');
  if(!response.ok)throw new ServiceUnavailableException('Reminder access validation is unavailable');
  return z.object({item:z.object({recipientEmail:z.email().max(254)})}).parse(await response.json()).item.recipientEmail;
 }catch(error){if(error instanceof ForbiddenException||error instanceof ServiceUnavailableException)throw error;throw new ServiceUnavailableException('Reminder access validation is unavailable');}
}
@Injectable()
export class StudentRemindersService {
 constructor(@Inject(Database)private readonly db:Database,@Inject(AuthMailService)private readonly mail:AuthMailService){}
 recipient=resolveReminderRecipient;
 private async access(ctx:RequestContext,studentId:string,operation:'read'|'write',targetKind?:'homework'|'planning'){
  if(!['student','parent'].includes(ctx.role))throw new ForbiddenException('A student portal account is required');
  assertPermission(ctx,`notifications.${operation}`);assertStudentAccess(ctx,studentId);
  await this.recipient({businessId:ctx.businessId,userId:ctx.sub,studentId,operation,targetKind});
 }
 async list(ctx:RequestContext,query:z.infer<typeof reminderListSchema>){
  await this.access(ctx,query.studentId,'read');
  return this.db.withTenant(ctx.businessId,async tx=>{
   // Due state is deterministic on list even when a schedule tick is delayed.
   await tx.query("UPDATE student_reminders SET state='due',updated_at=now() WHERE user_id=$1 AND student_id=$2 AND state='scheduled' AND remind_at<=now()",[ctx.sub,query.studentId]);
   const total=Number((await tx.query('SELECT count(*) total FROM student_reminders WHERE user_id=$1 AND student_id=$2',[ctx.sub,query.studentId])).rows[0].total);
   const rows=await tx.query<ReminderRow>("SELECT * FROM student_reminders WHERE user_id=$1 AND student_id=$2 ORDER BY CASE state WHEN 'due' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'read' THEN 2 ELSE 3 END,remind_at,id LIMIT $3 OFFSET $4",[ctx.sub,query.studentId,query.limit,query.offset]);
   return {items:rows.rows.map(reminderItem),total,limit:query.limit,offset:query.offset,emailAvailable:this.mail.status().available};
  });
 }
 private async target(ctx:RequestContext,input:ReminderInput,authorization:string){
  const resource=input.targetKind==='homework'?'learning':'planning';
  const path=input.targetKind==='homework'?`/v1/portal/assignments/${input.assignmentId}`:`/v1/cards/${input.cardId}`;
  if(!ctx.entitlements.includes(resource))throw new ForbiddenException('Reminder resource feature is unavailable');
  assertPermission(ctx,`${resource}.read`);
  if(!authorization?.startsWith('Bearer '))throw new ForbiddenException('Verified resource authorization is required');
  try {
   const response=await serviceFetch(resource,path,{headers:{Authorization:authorization},signal:AbortSignal.timeout(5000)});
   if(response.status===403||response.status===404)throw new NotFoundException('Reminder resource is unavailable');
   if(!response.ok)throw new ServiceUnavailableException('Reminder resource validation is unavailable');
   if(input.targetKind==='homework'){
    const value=z.object({item:z.object({id:z.uuid(),clientId:z.uuid(),title:z.string().min(1).max(200),status:z.string()})}).parse(await response.json()).item;
    assertStudentAccess(ctx,value.clientId);
    if(value.id!==input.assignmentId||value.clientId!==input.studentId)throw new NotFoundException('Reminder resource is unavailable');
    if(!['assigned','needs_revision'].includes(value.status))throw new ConflictException('This homework no longer needs a reminder');
    return value.title;
   }
   const value=z.object({item:z.object({id:z.uuid(),boardId:z.uuid(),title:z.string().min(1).max(200),archivedAt:z.string().nullable(),columnKind:z.string().optional()}),board:z.object({id:z.uuid(),studentId:z.uuid(),sharing:z.string(),archivedAt:z.string().nullable()})}).parse(await response.json());
   assertStudentAccess(ctx,value.board.studentId);
   if(value.item.id!==input.cardId||value.item.boardId!==input.boardId||value.board.id!==input.boardId||value.board.studentId!==input.studentId||value.board.sharing!=='student'||value.board.archivedAt||value.item.archivedAt)throw new NotFoundException('Shared reminder task is unavailable');
   if(value.item.columnKind==='completed')throw new ConflictException('This task no longer needs a reminder');
   return value.item.title;
  }catch(error){if(error instanceof ForbiddenException||error instanceof ConflictException||error instanceof NotFoundException||error instanceof ServiceUnavailableException)throw error;throw new ServiceUnavailableException('Reminder resource validation is unavailable');}
 }
 async create(ctx:RequestContext,input:ReminderInput,authorization:string){
  const at=new Date(input.remindAt),delta=at.getTime()-Date.now();
  if(delta<60_000||delta>365*86400_000)throw new BadRequestException('Choose a reminder from one minute to one year ahead');
  await this.access(ctx,input.studentId,'write',input.targetKind);
  const title=(await this.target(ctx,input,authorization)).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,200)||'Student task';
  try {return await this.db.withTenant(ctx.businessId,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.businessId}:reminders:${ctx.sub}:${input.studentId}`]);
   const count=Number((await tx.query("SELECT count(*) total FROM student_reminders WHERE user_id=$1 AND student_id=$2 AND state IN ('scheduled','due')",[ctx.sub,input.studentId])).rows[0].total);
   if(count>=100)throw new ConflictException('This student already has 100 active reminders');
   const row=(await tx.query<ReminderRow>(`INSERT INTO student_reminders(id,business_id,user_id,student_id,target_kind,assignment_id,board_id,card_id,title,remind_at,email_enabled,email_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[randomUUID(),ctx.businessId,ctx.sub,input.studentId,input.targetKind,input.targetKind==='homework'?input.assignmentId:null,input.targetKind==='planning'?input.boardId:null,input.targetKind==='planning'?input.cardId:null,title,at,input.emailEnabled,input.emailEnabled?'pending':'disabled'])).rows[0]!;
   await tx.query('INSERT INTO notification_reminder_directory(business_id) VALUES($1) ON CONFLICT DO NOTHING',[ctx.businessId]);
   await emitEvent(tx,{type:'notifications.reminder-created.v1',producer:'notifications',businessId:ctx.businessId,correlationId:ctx.requestId,data:{reminderId:row.id,studentId:row.student_id,targetKind:row.target_kind}});
   return {item:reminderItem(row)};
  });}catch(error){if((error as {code?:string}).code==='23505')throw new ConflictException('A reminder already exists for this task and time');throw error;}
 }
 async patch(ctx:RequestContext,id:string,input:z.infer<typeof reminderPatchSchema>){
  return this.db.withTenant(ctx.businessId,async tx=>{
   const row=(await tx.query<ReminderRow>('SELECT * FROM student_reminders WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,ctx.sub])).rows[0];
   if(!row)throw new NotFoundException('Reminder is unavailable');
   await this.access(ctx,row.student_id,'write');
   const next=input.action==='read'?'read':'cancelled';
   if(row.state===next)return {item:reminderItem(row)};
   const due=row.state==='scheduled'&&new Date(row.remind_at).getTime()<=Date.now();
   if(input.action==='read'&&row.state!=='due'&&!due)throw new ConflictException('Only due reminders can be marked read');
   if(input.action==='cancel'&&!['scheduled','due'].includes(row.state))throw new ConflictException('Only active reminders can be cancelled');
   const current=(await tx.query<ReminderRow>(`UPDATE student_reminders SET state=$2,read_at=CASE WHEN $2='read' THEN now() ELSE read_at END,cancelled_at=CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END,email_status=CASE WHEN $2='cancelled' AND email_status IN ('pending','sending') THEN 'suppressed' ELSE email_status END,email_reason=CASE WHEN $2='cancelled' AND email_status IN ('pending','sending') THEN 'cancelled' ELSE email_reason END,lease_token=CASE WHEN $2='cancelled' THEN NULL ELSE lease_token END,lease_until=CASE WHEN $2='cancelled' THEN NULL ELSE lease_until END,updated_at=now() WHERE id=$1 RETURNING *`,[id,next])).rows[0]!;
   if(row.lease_token&&next==='cancelled')await tx.query("UPDATE student_reminder_attempts SET status='suppressed',reason='cancelled',finished_at=now() WHERE id=$1 AND status='sending'",[row.lease_token]);
   await emitEvent(tx,{type:'notifications.reminder-updated.v1',producer:'notifications',businessId:ctx.businessId,correlationId:ctx.requestId,data:{reminderId:id,studentId:row.student_id,state:next}});
   return {item:reminderItem(current)};
  });
 }
}
@StudentScoped()
@Roles('student','parent')
@Controller('v1/portal/reminders')
export class StudentRemindersController {
 constructor(@Inject(StudentRemindersService)private readonly reminders:StudentRemindersService){}
 @Get() @Header('Cache-Control','no-store') @Permissions('notifications.read')
 list(@CurrentContext()ctx:RequestContext,@Query()query:unknown){return this.reminders.list(ctx,parseBody(reminderListSchema,query));}
 @Post() @Permissions('notifications.write')
 create(@CurrentContext()ctx:RequestContext,@Body()body:unknown,@Headers('authorization')authorization:string){return this.reminders.create(ctx,parseBody(reminderCreateSchema,body),authorization);}
 @Patch(':id') @Permissions('notifications.write')
 patch(@CurrentContext()ctx:RequestContext,@Param('id')id:string,@Body()body:unknown){return this.reminders.patch(ctx,parseBody(z.uuid(),id),parseBody(reminderPatchSchema,body));}
}
