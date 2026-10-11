import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {Database} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {PortalSessionsService,PortalSessionsController} from '../src/portal-sessions.js';
test('overview rejects extra fields and unauthorized students before reading records',async()=>{
 const student=randomUUID(),ctx:RequestContext={businessId:randomUUID(),sub:'synthetic',role:'student',entitlements:['scheduling'],requestId:randomUUID(),accessScope:'students',studentIds:[student]};
 const db={withTenant:async(_id:string,work:any)=>work({query:async(sql:string,values:any[])=>{if(sql.includes('canonical_student'))return {rows:[{id:values[0]}]};if(sql.includes('aliases'))return {rows:[]};throw new Error('Unexpected record read');}})} as unknown as Database;
 const service=new PortalSessionsService(db);
 await assert.rejects(service.overview(ctx,{studentId:randomUUID()}),{status:403});
 await assert.rejects(service.overview(ctx,{studentId:student,businessId:ctx.businessId}),{status:400});
 const target=randomUUID();
 const aliasDb={withTenant:async(_id:string,work:any)=>work({query:async(sql:string)=>sql.includes('canonical_student')?{rows:[{id:target}]}:{rows:[{target_id:target}]}})} as unknown as Database;
 await assert.rejects(new PortalSessionsService(aliasDb).overview(ctx,{studentId:student}),{status:403});
});
test('overview aggregate and bounded items enforce ordinary-role tenant/student isolation',{skip:!process.env.SCHEDULING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.SCHEDULING_TEST_DATABASE_URL}),tx=await pool.connect();
 const businessId=randomUUID(),student=randomUUID(),otherStudent=randomUUID();
 const ctx:RequestContext={businessId,sub:'synthetic',role:'student',entitlements:['scheduling'],requestId:randomUUID(),accessScope:'students',studentIds:[student]};
 try{
  const role=(await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  await tx.query('BEGIN');await tx.query("SELECT set_config('app.business_id',$1,true)",[businessId]);
  await tx.query("INSERT INTO sessions(id,business_id,client_id,title,starts_at,ends_at,created_by) SELECT gen_random_uuid(),$1,$2,'Synthetic',now()+n*interval '1 day',now()+n*interval '1 day'+interval '1 hour','synthetic' FROM generate_series(1,7) n",[businessId,student]);
  await tx.query("INSERT INTO sessions(id,business_id,client_id,title,starts_at,ends_at,created_by) VALUES(gen_random_uuid(),$1,$2,'Other student',now()+interval '20 days',now()+interval '20 days 1 hour','synthetic')",[businessId,otherStudent]);
  const cancelled=randomUUID();
  await tx.query("INSERT INTO external_sessions(id,business_id,connection_id,provider,external_id,owner_user_id,title,starts_at,ends_at,status) VALUES($1,$2,$3,'calcom','synthetic-cancelled','synthetic','Provider cancelled',now()+interval '1 hour',now()+interval '2 hours','cancelled')",[cancelled,businessId,randomUUID()]);
  await tx.query("INSERT INTO class_annotations(business_id,class_id,source,client_id,status) VALUES($1,$2,'external',$3,'scheduled')",[businessId,cancelled,student]);
  const db={withTenant:async(id:string,work:any)=>{await tx.query("SELECT set_config('app.business_id',$1,true)",[id]);return work(tx);}} as unknown as Database;
  const service=new PortalSessionsService(db),result=await service.overview(ctx,{studentId:student});
  assert.equal(result.summary.upcoming,7);assert.equal(result.sessions.length,5);
  assert.equal(result.sessions.some(row=>row.id===cancelled),false);
  assert.equal((await tx.query('SELECT status FROM class_annotations WHERE class_id=$1',[cancelled])).rows[0].status,'scheduled');
  await assert.rejects(service.overview(ctx,{studentId:otherStudent}),{status:403});
  const foreign=await service.overview({...ctx,businessId:randomUUID()},{studentId:student});
  assert.equal(foreign.summary.upcoming,0);assert.equal(foreign.sessions.length,0);
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
});

test('overview route opts into student scope and requires scheduling read',()=>{assert.equal(Reflect.getMetadata('palladium.student-scoped',PortalSessionsController),true);assert.deepEqual(Reflect.getMetadata('palladium.permissions',PortalSessionsController),['scheduling.read']);});
