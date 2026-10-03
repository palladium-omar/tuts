import { randomUUID } from 'node:crypto';
import { Body, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentContext, Database, EventBus, parseBody, Roles } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { eventPayloadSchemas,listSchema,notificationIntent,notificationSchema,NotificationEventType,statusSchema,uuid } from './schemas.js';

type Row={id:string;business_id:string;source_event_id:string|null;source_event_type:string|null;recipient_client_id:string|null;channel:string;title:string;message:string;status:string;delivery_mode:string;metadata:Record<string,unknown>;created_at:Date;updated_at:Date};
export function notificationView(row:Row){return {id:row.id,businessId:row.business_id,sourceEventId:row.source_event_id,sourceEventType:row.source_event_type,recipientClientId:row.recipient_client_id,channel:row.channel,title:row.title,message:row.message,status:row.status,deliveryMode:row.delivery_mode,metadata:row.metadata,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
@Injectable()
export class NotificationConsumer implements OnModuleInit {
 constructor(@Inject(EventBus) private readonly events:EventBus) {}
 onModuleInit(){
  for(const type of Object.keys(eventPayloadSchemas) as NotificationEventType[]) {
   this.events.subscribe(type,async(event,tx)=>{
    const intent=notificationIntent(type,event.data);
    await tx.query(`INSERT INTO notifications(id,business_id,source_event_id,source_event_type,recipient_client_id,title,message,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (business_id,source_event_id) DO NOTHING`,[randomUUID(),event.businessId,event.id,type,intent.recipientClientId,intent.title,intent.message,JSON.stringify(intent.metadata)]);
   });
  }
 }
}
@Injectable()
export class NotificationsService {
 constructor(@Inject(Database) private readonly db:Database) {}
 async list(ctx:RequestContext,query:unknown){
  const q=parseBody(listSchema,query);
  return this.db.withTenant(ctx.businessId,async tx=>({items:(await tx.query<Row>('SELECT * FROM notifications WHERE business_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,id LIMIT $3',[ctx.businessId,q.status ?? null,q.limit])).rows.map(notificationView)}));
 }
 async create(ctx:RequestContext,body:unknown){
  const v=parseBody(notificationSchema,body);
  return this.db.withTenant(ctx.businessId,async tx=>{
   const result=await tx.query<Row>('INSERT INTO notifications(id,business_id,recipient_client_id,channel,title,message,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),ctx.businessId,v.recipientClientId ?? null,v.channel,v.title,v.message,ctx.sub]);
   return {item:notificationView(result.rows[0]!)};
  });
 }
 async updateStatus(ctx:RequestContext,id:string,body:unknown){
  parseBody(uuid,id);const v=parseBody(statusSchema,body);
  return this.db.withTenant(ctx.businessId,async tx=>{
   const row=(await tx.query<Row>('SELECT * FROM notifications WHERE business_id=$1 AND id=$2 FOR UPDATE',[ctx.businessId,id])).rows[0];
   if(!row) throw new NotFoundException('Notification not found');
   if(row.status===v.status) return {item:notificationView(row)};
   if(row.status !== 'queued') throw new ConflictException('Only queued notifications can be marked read or cancelled');
   if(v.status==='read' && row.channel !== 'in_app') throw new ConflictException('Email intents cannot be marked read; external delivery is unavailable');
   const result=await tx.query<Row>('UPDATE notifications SET status=$3,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',[ctx.businessId,id,v.status]);
   return {item:notificationView(result.rows[0]!)};
  });
 }
}
@ApiTags('notifications') @Roles('owner','admin','tutor') @Controller('v1/notifications')
export class NotificationsController {
 constructor(@Inject(NotificationsService) private readonly notifications:NotificationsService) {}
 @ApiQuery({name:'status',required:false,enum:['queued','read','cancelled']}) @ApiQuery({name:'limit',required:false,type:Number})
 @Get() @ApiOperation({summary:'List queued notification intents for staff; no external messages are sent'})
 list(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.notifications.list(ctx,query);}
 @ApiBody({schema:{type:'object',additionalProperties:false,required:['title','message'],properties:{title:{type:'string',maxLength:200},message:{type:'string',maxLength:5000},channel:{type:'string',enum:['in_app','email'],default:'in_app'},recipientClientId:{type:'string',format:'uuid'}}}})
 @Post() @ApiOperation({summary:'Queue an in-app or email notification intent; delivery mode is queue_only'})
 create(@CurrentContext() ctx:RequestContext,@Body() body:unknown){return this.notifications.create(ctx,body);}
 @ApiBody({schema:{type:'object',additionalProperties:false,required:['status'],properties:{status:{type:'string',enum:['read','cancelled']}}}})
 @Patch(':id') @ApiOperation({summary:'Mark an in-app notification read or cancel a queued intent'})
 update(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown){return this.notifications.updateStatus(ctx,id,body);}
}
