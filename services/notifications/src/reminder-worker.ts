import {randomUUID} from 'node:crypto';
import {ForbiddenException, Inject, Injectable, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {Database, emitEvent, EventBus, isCloudflareRuntime} from '@palladium/service-kit';
import type {PlatformEvent} from '@palladium/contracts';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {AuthMailService} from './auth-mail.js';
import {AuthMailDeliveryError} from './auth-mail-providers.js';
import {reminderPath, resolveReminderRecipient, type ReminderRow} from './student-reminders.js';
import {budgetRemaining, notificationDeadline, reminderLeaseBudgetMs} from './tick-budget.js';
const terminalSchema=z.object({studentId:z.uuid()});
/** Terminal events only suppress; no event can grant access or reactivate work. */
export async function suppressReminders(event:PlatformEvent,tx:PoolClient){
 let condition:string,args:unknown[],reason='resource_closed';
 if(event.type==='learning.assignment-reviewed.v1'){
  if(event.producer!=='learning')throw new Error('Invalid reminder resource producer');
  const data=terminalSchema.extend({assignmentId:z.uuid(),status:z.string(),revision:z.number().int().positive()}).parse(event.data);
  if(data.status!=='completed')return;
  condition='student_id=$3 AND assignment_id=$4';args=[data.studentId,data.assignmentId];
 }else if(event.type==='planning.board-updated.v1'||event.type==='planning.card-updated.v1'){
  if(event.producer!=='planning')throw new Error('Invalid reminder resource producer');
  const data=terminalSchema.extend({boardId:z.uuid(),cardId:z.uuid().optional(),archived:z.boolean(),completed:z.boolean().optional(),sharing:z.enum(['student','private']),revision:z.number().int().positive()}).parse(event.data);
  if(!data.archived&&data.sharing==='student'&&data.completed!==true)return;
  condition='student_id=$3 AND board_id=$4';args=[data.studentId,data.boardId];
  if(event.type==='planning.card-updated.v1'){
   if(!data.cardId)throw new Error('Invalid reminder card');
   condition+=' AND card_id=$5';args.push(data.cardId);
  }
 }else if(event.type==='platform.portal-access-revoked.v1'){
  if(event.producer!=='platform')throw new Error('Invalid reminder access producer');
  const data=terminalSchema.extend({userId:z.string().min(1).max(200)}).parse(event.data);
  condition='student_id=$3 AND user_id=$4';args=[data.studentId,data.userId];reason='access_revoked';
 }else return;
 const rows=(await tx.query<ReminderRow>(`UPDATE student_reminders SET state=CASE WHEN state='read' THEN state ELSE 'cancelled' END,cancelled_at=CASE WHEN state='read' THEN cancelled_at ELSE now() END,email_status=CASE WHEN email_status IN ('pending','sending') THEN 'suppressed' ELSE email_status END,email_reason=CASE WHEN email_status IN ('pending','sending') THEN '${reason}' ELSE email_reason END,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=$1 AND created_at<=$2::timestamptz AND (state IN ('scheduled','due') OR (state='read' AND email_status IN ('pending','sending'))) AND ${condition} RETURNING *`,[event.businessId,event.occurredAt,...args])).rows;
 for(const row of rows){
  await tx.query("UPDATE student_reminder_attempts SET status='suppressed',reason=$2,finished_at=now() WHERE reminder_id=$1 AND status='sending'",[row.id,reason]);
  await emitEvent(tx,{type:'notifications.reminder-updated.v1',producer:'notifications',businessId:event.businessId,correlationId:event.correlationId,data:{reminderId:row.id,studentId:row.student_id,state:row.state}});
 }
}
@Injectable()
export class ReminderWorker implements OnModuleInit,OnModuleDestroy {
 private interval?:ReturnType<typeof setInterval>;
 private busy=false;
 private stopping=false;
 recipient=resolveReminderRecipient;
 constructor(@Inject(Database)private readonly db:Database,@Inject(EventBus)private readonly events:EventBus,@Inject(AuthMailService)private readonly mail:AuthMailService){}
 onModuleInit(){
  for(const type of ['learning.assignment-reviewed.v1','planning.board-updated.v1','planning.card-updated.v1','platform.portal-access-revoked.v1'])this.events.subscribe(type,suppressReminders);
  if(isCloudflareRuntime())return;
  this.interval=setInterval(()=>void this.tick(),15_000);this.interval.unref();
 }
 onModuleDestroy(){this.stopping=true;if(this.interval)clearInterval(this.interval);}
 async tick(deadline=notificationDeadline()){
  if(this.busy||this.stopping)return;this.busy=true;
  try {
   // Persist fairness in the directory: Workers instances do not retain cursors.
   const tenants=await this.db.transaction(async tx=>{
    const rows=(await tx.query<{business_id:string}>('SELECT business_id FROM notification_reminder_directory ORDER BY last_scan_at,business_id FOR UPDATE SKIP LOCKED LIMIT 5')).rows;
    for(const row of rows)await tx.query('UPDATE notification_reminder_directory SET last_scan_at=now() WHERE business_id=$1',[row.business_id]);
    return rows;
   });
   for(const row of tenants){if(this.stopping||budgetRemaining(deadline)<500)break;await this.processTenant(row.business_id,deadline);}
  }catch{console.warn('[notifications] reminder pass could not complete');}finally{this.busy=false;}
 }
 private async deferLease(tx:PoolClient,row:ReminderRow){
  // No provider call has begun; returning this owned lease to pending is safe.
  await tx.query("UPDATE student_reminders SET email_status='pending',email_reason=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[row.id,row.lease_token]);
  await tx.query("UPDATE student_reminder_attempts SET status='suppressed',reason='budget_deferred',finished_at=now() WHERE id=$1 AND status='sending'",[row.lease_token]);
 }
 async processTenant(businessId:string,deadline=notificationDeadline()){
  await this.db.withTenant(businessId,async tx=>{
   await tx.query("UPDATE student_reminders SET state='due',updated_at=now() WHERE id IN (SELECT id FROM student_reminders WHERE state='scheduled' AND remind_at<=now() ORDER BY remind_at,id FOR UPDATE SKIP LOCKED LIMIT 100)");
   // An expired lease can have crossed provider acceptance. Never resend it.
   const expired=(await tx.query<{lease_token:string}>("SELECT lease_token FROM student_reminders WHERE email_status='sending' AND lease_until<=now() ORDER BY lease_until,id FOR UPDATE SKIP LOCKED LIMIT 100")).rows;
   for(const row of expired)await tx.query("UPDATE student_reminder_attempts SET status='unknown',reason='lease_expired_acceptance_unknown',finished_at=now() WHERE id=$1 AND status='sending'",[row.lease_token]);
   if(expired.length)await tx.query("UPDATE student_reminders SET email_status='unknown',email_reason='lease_expired_acceptance_unknown',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE lease_token=ANY($1::uuid[])",[expired.map(row=>row.lease_token)]);
  });
  for(let count=0;count<2;count++){
   if(budgetRemaining(deadline)<reminderLeaseBudgetMs)break;
   const row=await this.db.withTenant(businessId,async tx=>{
    const reminder=(await tx.query<ReminderRow>("SELECT * FROM student_reminders WHERE state IN ('due','read') AND remind_at<=now() AND email_status='pending' ORDER BY remind_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if(!reminder)return null;
    if(!this.mail.status().available){await tx.query("UPDATE student_reminders SET email_status='failed',email_reason='sender_unavailable',updated_at=now() WHERE id=$1",[reminder.id]);return {unavailable:true} as const;}
    if(budgetRemaining(deadline)<reminderLeaseBudgetMs)return null;
    const token=randomUUID();
    await tx.query("UPDATE student_reminders SET email_status='sending',lease_token=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1",[reminder.id,token]);
    await tx.query("INSERT INTO student_reminder_attempts(id,business_id,reminder_id,idempotency_key,status) VALUES($1,$2,$3,$4,'sending')",[token,businessId,reminder.id,`tuts-student-reminder-${reminder.id}`]);
    return {...reminder,lease_token:token};
   });
   if(!row)break;if('unavailable'in row)continue;
   // Serialize cancellation and terminal event handlers at the send boundary.
   // If persistence fails after acceptance, the durable lease becomes unknown.
   await this.db.withTenant(businessId,async tx=>{
    const current=(await tx.query<ReminderRow>("SELECT * FROM student_reminders WHERE id=$1 AND lease_token=$2 AND email_status='sending' AND lease_until>now() AND state IN ('due','read') FOR UPDATE",[row.id,row.lease_token])).rows[0];
    if(!current)return;
    let status='unknown',reason:string|null='acceptance_unknown',providerId:string|null=null;
    try {
     if(budgetRemaining(deadline)<reminderLeaseBudgetMs){
      await this.deferLease(tx,current);return;
     }
     const recipientEmail=await this.recipient({businessId,userId:current.user_id,studentId:current.student_id,targetKind:current.target_kind,operation:'delivery'});
     if(budgetRemaining(deadline)<13_000){await this.deferLease(tx,current);return;}
     providerId=await this.mail.sendStudentReminder({recipientEmail,reminderId:current.id,title:current.title,portalPath:reminderPath(current)});
     status='accepted';reason=null;
    }catch(error){
     if(error instanceof ForbiddenException){status='suppressed';reason='access_revoked';}
     else if(error instanceof AuthMailDeliveryError){
      // Explicit provider rejection is a definite failure. A dropped response
      // leaves acceptance unknown after immediate same-key transport retries.
      status=error.category==='provider_rejected'?'failed':'unknown';reason=status==='failed'?'provider_rejected':'acceptance_unknown';
     }else {status='failed';reason=this.mail.status().available?'recipient_unavailable':'sender_unavailable';}
    }
    await tx.query('UPDATE student_reminders SET email_status=$3,email_reason=$4,provider_message_id=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2',[current.id,current.lease_token,status,reason,providerId]);
    await tx.query('UPDATE student_reminder_attempts SET status=$2,reason=$3,provider_message_id=$4,finished_at=now() WHERE id=$1',[current.lease_token,status,reason,providerId]);
    await emitEvent(tx,{type:'notifications.reminder-delivery.v1',producer:'notifications',businessId,data:{reminderId:current.id,studentId:current.student_id,emailStatus:status}});
   });
  }
 }
}
