import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Database} from '@palladium/service-kit';
import {IdentityService} from '../src/identity.service.js';
import {assertReminderSecret,recipientRequestSchema,ReminderRecipientService} from '../src/reminder-recipient.js';
test('private reminder recipient rejects arbitrary addresses, malformed accounts and missing/wrong internal secret',()=>{
 const before=process.env.AUTH_MAIL_INTERNAL_SECRET;process.env.AUTH_MAIL_INTERNAL_SECRET='s'.repeat(32);
 try{assert.throws(()=>assertReminderSecret(undefined),{status:401});assert.throws(()=>assertReminderSecret('x'.repeat(32)),{status:401});assert.doesNotThrow(()=>assertReminderSecret('s'.repeat(32)));assert.equal(recipientRequestSchema.safeParse({businessId:randomUUID(),studentId:randomUUID(),userId:'synthetic',operation:'delivery',recipientEmail:'attacker@example.invalid'}).success,false);}finally{if(before===undefined)delete process.env.AUTH_MAIL_INTERNAL_SECRET;else process.env.AUTH_MAIL_INTERNAL_SECRET=before;}
});
test('current account own email requires student/parent role, scope, feature/permission overrides and active grant under ordinary role',{skip:!process.env.PLATFORM_TEST_DATABASE_URL},async()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL=process.env.PLATFORM_TEST_DATABASE_URL;const db=new Database();if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
 const businessId=randomUUID(),otherTenant=randomUUID(),userId=randomUUID(),otherUser=randomUUID(),studentId=randomUUID();
 const identity=Object.assign(Object.create(IdentityService.prototype),{database:db}) as IdentityService;
 const service=new ReminderRecipientService(db,identity),input={businessId,userId,studentId,targetKind:'homework' as const,operation:'delivery' as const};
 const originalFetch=globalThis.fetch,secretBefore=process.env.PORTAL_INTERNAL_SECRET,urlBefore=process.env.CLIENTS_URL;
 process.env.PORTAL_INTERNAL_SECRET='s'.repeat(32);process.env.CLIENTS_URL='http://127.0.0.1:4002';let inactive=false;
 globalThis.fetch=async(_input,init)=>{assert.equal(JSON.parse(init!.body as string).protect,true);return inactive?new Response('',{status:409}):Response.json({item:{id:studentId}});};
 const permissions=['notifications.read','notifications.write','learning.read','clients.read'];
 try{
  const role=(await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  await db.migrate(fileURLToPath(new URL('../migrations',import.meta.url)));
  await db.pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3),($4,$2,$5)',[userId,'Synthetic reminders',`${userId}@example.invalid`,otherUser,`${otherUser}@example.invalid`]);
  await db.withTenant(businessId,async tx=>{
   await tx.query("INSERT INTO businesses(business_id,name,entitlements) VALUES($1,'Synthetic reminders',$2)",[businessId,['notifications','learning','clients']]);
   for(const id of [userId,otherUser])await tx.query("INSERT INTO memberships(business_id,user_id,role,access_scope,permissions_override) VALUES($1,$2,'student','students',$3)",[businessId,id,permissions]);
   await tx.query("INSERT INTO portal_student_access(business_id,user_id,student_id,relationship) VALUES($1,$2,$3,'student')",[businessId,userId,studentId]);
  });
  assert.equal((await service.resolve(input)).item.recipientEmail,`${userId}@example.invalid`);
  await assert.rejects(service.resolve({...input,userId:otherUser}),{status:403});
  await assert.rejects(service.resolve({...input,businessId:otherTenant}),{status:403});
  inactive=true;await assert.rejects(service.resolve(input),{status:403});inactive=false;
  await db.withTenant(businessId,tx=>tx.query("UPDATE memberships SET permissions_override='{}' WHERE user_id=$1",[userId]));await assert.rejects(service.resolve(input),{status:403});
  await db.withTenant(businessId,tx=>tx.query('UPDATE memberships SET permissions_override=$2 WHERE user_id=$1',[userId,permissions]));
  await db.withTenant(businessId,tx=>tx.query("UPDATE memberships SET role='tutor' WHERE user_id=$1",[userId]));await assert.rejects(service.resolve(input),{status:403});
  await db.withTenant(businessId,tx=>tx.query("UPDATE memberships SET role='student' WHERE user_id=$1",[userId]));
  await db.withTenant(businessId,tx=>tx.query("UPDATE businesses SET entitlements=ARRAY['clients','notifications']"));await assert.rejects(service.resolve(input),{status:403});
  await db.withTenant(businessId,tx=>tx.query("UPDATE businesses SET entitlements=ARRAY['clients','notifications','learning']"));
  await db.withTenant(businessId,tx=>tx.query("UPDATE portal_student_access SET revoked_at=now() WHERE user_id=$1",[userId]));await assert.rejects(service.resolve(input),{status:403});
 }finally{
  globalThis.fetch=originalFetch;if(secretBefore===undefined)delete process.env.PORTAL_INTERNAL_SECRET;else process.env.PORTAL_INTERNAL_SECRET=secretBefore;if(urlBefore===undefined)delete process.env.CLIENTS_URL;else process.env.CLIENTS_URL=urlBefore;
  await db.withTenant(businessId,async tx=>{await tx.query('DELETE FROM portal_student_access WHERE business_id=$1',[businessId]);await tx.query('DELETE FROM memberships WHERE business_id=$1',[businessId]);await tx.query('DELETE FROM businesses WHERE business_id=$1',[businessId]);});await db.pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])',[[userId,otherUser]]);await db.pool.end();
 }
});
