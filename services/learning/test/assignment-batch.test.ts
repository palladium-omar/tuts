import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool, type PoolClient} from 'pg';
import type {Database} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {LearningService} from '../src/learning-service.js';
const ctx:RequestContext={businessId:randomUUID(),sub:'synthetic',role:'owner',entitlements:['learning'],requestId:randomUUID()},student=randomUUID(),resource=randomUUID();
const row=(client_id=student)=>({id:randomUUID(),client_id,business_id:ctx.businessId,created_at:new Date(),updated_at:new Date(),resource_ids:[resource],submission_resource_ids:[resource]});
function stub(rows:any[],resourceClient=student){const queries:string[]=[];const db={withTenant:async(_id:string,work:any)=>work({query:async(sql:string)=>{queries.push(sql);return {rows:sql.includes('count(*)')?[{total:String(rows.length)}]:sql.startsWith('SELECT * FROM resources')?[{id:resource,client_id:resourceClient,created_at:new Date(),size_bytes:null}]:rows};}})} as unknown as Database;return {service:new LearningService(db),queries};}
test('assignment cards fetch all resource details once, with assignment and resource identity authorization',async()=>{
 for(const size of [1,50,100,200]){const {service,queries}=stub(Array.from({length:size},()=>row()));const result=await service.listAssignments(ctx,{limit:200});assert.equal(queries.length,3);assert.equal(result.items.length,size);assert.equal(result.items[0]!.resources.length,1);assert.equal(result.items[0]!.submissionResources.length,1);}
 const scoped={...ctx,role:'student' as const,accessScope:'students' as const,studentIds:[student]};let s=stub([row(randomUUID())]);await assert.rejects(s.service.listAssignments(scoped,{},true),/Student access/);assert.equal(s.queries.length,2);
 s=stub([row()],randomUUID());await assert.rejects(s.service.listAssignments(scoped,{},true),/Student access/);
 s=stub([row()],randomUUID());await assert.rejects(s.service.listAssignments(ctx,{}),/identity needs reconciliation/);
});
test('real PostgreSQL assignment list has constant three queries with shared resources and tenant isolation',{skip:!process.env.LEARNING_TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.LEARNING_TEST_DATABASE_URL}),tx=await pool.connect();
 try{
  await tx.query('BEGIN');await tx.query("SELECT set_config('app.business_id',$1,true)",[ctx.businessId]);
  await tx.query("INSERT INTO resources(business_id,id,client_id,title,kind,file_name,storage_status,created_by) VALUES($1,$2,$3,'Synthetic','file_metadata','lesson.pdf','upload_pending','synthetic')",[ctx.businessId,resource,student]);
  const ids=Array.from({length:100},()=>randomUUID());await tx.query("INSERT INTO assignments(business_id,id,client_id,title,created_by) SELECT $1,id,$2,'Synthetic','synthetic' FROM unnest($3::uuid[]) id",[ctx.businessId,student,ids]);
  await tx.query('INSERT INTO assignment_resources(business_id,assignment_id,resource_id) SELECT $1,id,$2 FROM unnest($3::uuid[]) id',[ctx.businessId,resource,ids]);
  let queries=0;const counted=new Proxy(tx,{get(target,key){if(key==='query')return (...args:any[])=>{queries++;return (target.query as any).apply(target,args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const db={withTenant:async(id:string,work:(tx:PoolClient)=>unknown)=>{await tx.query("SELECT set_config('app.business_id',$1,true)",[id]);return work(counted);}} as unknown as Database,service=new LearningService(db);
  const result=await service.listAssignments(ctx,{limit:200});assert.equal(queries,3);assert.equal(result.items.length,100);assert.ok(result.items.every(item=>item.resources[0]!.id===resource));
  assert.equal((await service.listAssignments({...ctx,businessId:randomUUID()},{})).items.length,0);
 }finally{await tx.query('ROLLBACK');tx.release();await pool.end();}
});
