import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Database,EventBus } from '@palladium/service-kit';
import type { PlatformEvent,RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { notificationIntent,notificationSchema,statusSchema } from '../src/schemas.js';
import { NotificationConsumer,NotificationsController,NotificationsService } from '../src/notifications.js';
test('notification API cannot claim delivery or override tenant',()=>{
 assert.equal(notificationSchema.safeParse({title:'Reminder',message:'Study',businessId:randomUUID()}).success,false);
 assert.equal(statusSchema.safeParse({status:'delivered'}).success,false);
 const data=notificationIntent('clients.client-created.v1',{clientId:randomUUID(),privateNotes:'SECRET',email:'private@example.com'});assert.equal('privateNotes' in data.metadata,false);assert.equal('email' in data.metadata,false);
 assert.throws(()=>notificationIntent('scheduling.session-created.v1',{sessionId:randomUUID(),clientId:randomUUID()}));
 assert.match(notificationIntent('payments.payment-confirmed.v1',{paymentId:randomUUID(),invoiceId:randomUUID(),amountMinor:1000,currency:'USD',provider:'sandbox'}).title,/simulated/);
});
test('notification routes are staff-only',()=>assert.deepEqual(Reflect.getMetadata('palladium.roles',NotificationsController),['owner','admin','tutor']));
test('consumer registers durable event handlers and does not blindly copy event payloads',async()=>{
 const handlers=new Map<string,(event:PlatformEvent,tx:PoolClient)=>Promise<void>>();
 const consumer=new NotificationConsumer({subscribe:(type:string,handler:(event:PlatformEvent,tx:PoolClient)=>Promise<void>)=>handlers.set(type,handler)} as unknown as EventBus);consumer.onModuleInit();assert.equal(handlers.size,6);
 let parameters:unknown[]=[];const tx={query:async(_sql:string,params:unknown[])=>{parameters=params;return {rows:[]};}} as unknown as PoolClient;
 const event:PlatformEvent={id:randomUUID(),type:'clients.client-created.v1',businessId:randomUUID(),version:1,producer:'clients',occurredAt:new Date().toISOString(),correlationId:randomUUID(),data:{clientId:randomUUID(),privateNotes:'SECRET'}};
 await handlers.get(event.type)!(event,tx);assert.equal(parameters[1],event.businessId);assert.equal(parameters[2],event.id);assert.equal(String(parameters[7]).includes('SECRET'),false);
});
test('PostgreSQL isolates notification intents, prevents duplicate event effects and keeps email queued', {skip:!process.env.NOTIFICATIONS_TEST_DATABASE_URL},async()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL=process.env.NOTIFICATIONS_TEST_DATABASE_URL;
 const db=new Database();if(previous === undefined) delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
 try {
  const role=(await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  await db.migrate(fileURLToPath(new URL('../migrations',import.meta.url)));
  const ctx:RequestContext={businessId:randomUUID(),sub:'staff',role:'admin',entitlements:['notifications'],requestId:randomUUID()};const other={...ctx,businessId:randomUUID()};const service=new NotificationsService(db);
  const handlers=new Map<string,(event:PlatformEvent,tx:PoolClient)=>Promise<void>>();new NotificationConsumer({subscribe:(type:string,handler:(event:PlatformEvent,tx:PoolClient)=>Promise<void>)=>handlers.set(type,handler)} as unknown as EventBus).onModuleInit();
  const event:PlatformEvent={id:randomUUID(),type:'clients.client-created.v1',businessId:ctx.businessId,version:1,producer:'clients',occurredAt:new Date().toISOString(),correlationId:randomUUID(),data:{clientId:randomUUID()}};
  for(let i=0;i<2;i++) await db.withTenant(ctx.businessId,tx=>handlers.get(event.type)!(event,tx));
  assert.equal((await service.list(ctx,{})).items.length,1);assert.equal((await service.list(other,{})).items.length,0);
  const email=await service.create(ctx,{title:'Reminder',message:'Queued only',channel:'email'});assert.equal(email.item.status,'queued');assert.equal(email.item.deliveryMode,'queue_only');
  await assert.rejects(service.updateStatus(ctx,email.item.id,{status:'read'}),{status:409});await assert.rejects(service.updateStatus(other,email.item.id,{status:'cancelled'}),{status:404});
  const cancelled=await service.updateStatus(ctx,email.item.id,{status:'cancelled'});assert.equal(cancelled.item.status,'cancelled');
  assert.equal((await db.pool.query('SELECT * FROM notifications WHERE id=$1',[email.item.id])).rows.length,0);
  await db.withTenant(ctx.businessId,tx=>tx.query('DELETE FROM notifications WHERE business_id=$1',[ctx.businessId]));
 } finally {await db.pool.end();}
});
