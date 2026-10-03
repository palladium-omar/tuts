import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { createSessionSchema, listSessionsSchema, updateSessionSchema } from '../src/schemas.js';
import { SessionsController, SessionsService } from '../src/sessions.js';
const input={clientId:randomUUID(),title:'Math',startsAt:'2026-12-01T10:00:00.000Z',endsAt:'2026-12-01T11:00:00.000Z'};
const context:RequestContext={businessId:randomUUID(),sub:'opaque-auth-user',role:'tutor',entitlements:['scheduling'],requestId:randomUUID()};
test('session input rejects tenant overrides, reversed times and non-UTC datetimes',()=>{
 assert.equal(createSessionSchema.safeParse({...input,businessId:randomUUID()}).success,false);
 assert.equal(createSessionSchema.safeParse({...input,endsAt:input.startsAt}).success,false);
 assert.equal(createSessionSchema.safeParse({...input,startsAt:'2026-12-01T10:00:00+01:00'}).success,false);
 assert.equal(createSessionSchema.safeParse({...input,assignedTutorId:'opaque-auth-user'}).success,true);
 assert.equal(updateSessionSchema.safeParse({}).success,false);
 assert.equal(listSessionsSchema.safeParse({limit:201}).success,false);
});
test('student and parent roles cannot use staff controller',()=>assert.deepEqual(Reflect.getMetadata('palladium.roles',SessionsController),['owner','admin','tutor']));
test('assigning an unverified tutor is rejected before persistence',async()=>{
 const service=new SessionsService({withTenant:()=>{throw new Error('Should not touch DB');}} as unknown as Database);
 await assert.rejects(service.create(context,{...input,assignedTutorId:'someone-else'}),{status:403});
 await assert.rejects(service.update(context,randomUUID(),{assignedTutorId:'someone-else'}),{status:403});
});
test('PostgreSQL isolates tenants, rejects overlapping concurrent bookings and deduplicates completion', {skip:!process.env.SCHEDULING_TEST_DATABASE_URL},async()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL=process.env.SCHEDULING_TEST_DATABASE_URL;
 const db=new Database();if(previous === undefined) delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
 try {
  const role=(await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(role.rolsuper,false,'RLS test requires a non-superuser role');assert.equal(role.rolbypassrls,false);
  await db.migrate(fileURLToPath(new URL('../migrations',import.meta.url)));
  const service=new SessionsService(db);const ctx={...context,businessId:randomUUID()};const other={...ctx,businessId:randomUUID()};
  const results=await Promise.allSettled([service.create(ctx,input),service.create(ctx,input)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failure.reason.status,409);
  const item=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>>).value!.item;
  await assert.rejects(service.create(ctx,{...input,clientId:randomUUID()}),{status:409});
  const adjacent=await service.create(ctx,{...input,startsAt:input.endsAt,endsAt:'2026-12-01T12:00:00.000Z'});assert.ok(adjacent.item.id,'Adjacent sessions do not overlap');
  await assert.rejects(db.withTenant(ctx.businessId,tx=>tx.query('INSERT INTO sessions(id,business_id,client_id,title,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ctx.businessId,input.clientId,input.title,input.startsAt,input.endsAt,ctx.sub])),{code:'23P01'});
  assert.equal((await service.list(other,{})).items.length,0);
  await assert.rejects(service.transition(other,item.id,'completed'),{status:404});
  assert.equal((await db.pool.query('SELECT * FROM sessions WHERE id=$1',[item.id])).rows.length,0,'RLS fails closed without tenant context');
  await assert.rejects(db.withTenant(ctx.businessId,tx=>tx.query('INSERT INTO sessions(id,business_id,client_id,title,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),other.businessId,input.clientId,input.title,input.startsAt,input.endsAt,ctx.sub])),{code:'42501'});
  await service.transition(ctx,item.id,'completed');await service.transition(ctx,item.id,'completed');
  const events=await db.pool.query("SELECT event FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='scheduling.session-completed.v1'",[ctx.businessId]);assert.equal(events.rows.length,1);
  const next=await service.create(ctx,input);assert.ok(next.item.id,'Completing a booking frees the active slot');
  await service.create(other,input);
  await db.withTenant(ctx.businessId,tx=>tx.query('DELETE FROM sessions WHERE business_id=$1',[ctx.businessId]));
  await db.withTenant(other.businessId,tx=>tx.query('DELETE FROM sessions WHERE business_id=$1',[other.businessId]));
  await db.pool.query("DELETE FROM service_outbox WHERE event->>'businessId'=ANY($1::text[])",[[ctx.businessId,other.businessId]]);
 } finally {await db.pool.end();}
});
