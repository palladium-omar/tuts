import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {Database} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {PortalLearningController} from '../src/portal.controller.js';
import {LearningService} from '../src/learning-service.js';
test('overview rejects extra fields and unauthorized students before reading records',async()=>{
 const student=randomUUID(),ctx:RequestContext={businessId:randomUUID(),sub:'synthetic',role:'student',entitlements:['learning'],requestId:randomUUID(),accessScope:'students',studentIds:[student]};
 const db={withTenant:async(_id:string,work:any)=>work({query:async(sql:string,values:any[])=>{if(sql.includes('canonical_student'))return {rows:[{id:values[0]}]};if(sql.includes('aliases'))return {rows:[]};throw new Error('Unexpected record read');}})} as unknown as Database;
 const service=new LearningService(db);
 await assert.rejects(service.overview(ctx,{studentId:randomUUID()}),{status:403});
 await assert.rejects(service.overview(ctx,{studentId:student,businessId:ctx.businessId}),{status:400});
 const target=randomUUID();
 const aliasDb={withTenant:async(_id:string,work:any)=>work({query:async(_sql:string,values:any[])=>({rows:values[0]===student?[{target_id:target}]:[]})})} as unknown as Database;
 await assert.rejects(new LearningService(aliasDb).overview(ctx,{studentId:student}),{status:403});
});
test('overview aggregate and bounded items enforce ordinary-role tenant/student isolation',{skip:!process.env.LEARNING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.LEARNING_TEST_DATABASE_URL}),tx=await pool.connect();
 const businessId=randomUUID(),student=randomUUID(),otherStudent=randomUUID();
 const ctx:RequestContext={businessId,sub:'synthetic',role:'student',entitlements:['learning'],requestId:randomUUID(),accessScope:'students',studentIds:[student]};
 try{
  const role=(await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  await tx.query('BEGIN');await tx.query("SELECT set_config('app.business_id',$1,true)",[businessId]);
  await tx.query("INSERT INTO assignments(id,business_id,client_id,title,due_at,status,created_by) SELECT gen_random_uuid(),$1,$2,'Synthetic',now()-interval '1 day','assigned','synthetic' FROM generate_series(1,12)",[businessId,student]);
  await tx.query("INSERT INTO assignments(id,business_id,client_id,title,created_by) VALUES(gen_random_uuid(),$1,$2,'Other student','synthetic')",[businessId,otherStudent]);
  const db={withTenant:async(id:string,work:any)=>{await tx.query("SELECT set_config('app.business_id',$1,true)",[id]);return work(tx);}} as unknown as Database;
  const service=new LearningService(db),result=await service.overview(ctx,{studentId:student});
  assert.equal(result.summary.pending,12);assert.equal(result.summary.overdue,12);assert.equal(result.homework.length,8);
  await assert.rejects(service.overview(ctx,{studentId:otherStudent}),{status:403});
  const foreign=await service.overview({...ctx,businessId:randomUUID()},{studentId:student});
  assert.equal(foreign.summary.total,0);assert.equal(foreign.homework.length,0);
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
});

test('overview route opts into student scope and requires learning read',()=>{assert.equal(Reflect.getMetadata('palladium.student-scoped',PortalLearningController),true);assert.deepEqual(Reflect.getMetadata('palladium.permissions',PortalLearningController.prototype.overview),['learning.read']);});
