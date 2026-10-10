import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { assignmentSchema,resourceSchema,reviewSchema,submissionSchema,listSchema,portalAssignmentListSchema } from '../src/schemas.js';
import { AssignmentsController,LearningService,ResourcesController } from '../src/learning.js';
const clientId=randomUUID();
test('actionable filters are an additive portal contract with bounded pagination',()=>{
 assert.equal(portalAssignmentListSchema.safeParse({clientId,status:'actionable',limit:20,offset:0}).success,true);
 assert.equal(listSchema.safeParse({status:'actionable'}).success,false);
 assert.equal(portalAssignmentListSchema.safeParse({status:'actionable',businessId:randomUUID()}).success,false);
 assert.equal(portalAssignmentListSchema.safeParse({status:'actionable',limit:201}).success,false);
});
test('learning rejects tenant overrides, duplicate resources and unsafe links',()=>{
 assert.equal(assignmentSchema.safeParse({clientId,title:'Math',businessId:randomUUID()}).success,false);
 const id=randomUUID();assert.equal(assignmentSchema.safeParse({clientId,title:'Math',resourceIds:[id,id]}).success,false);
 assert.equal(resourceSchema.safeParse({clientId,title:'Link',kind:'link',url:'javascript:alert(1)'}).success,false);
 assert.equal(resourceSchema.safeParse({clientId,title:'Link',kind:'link',url:'http://example.com'}).success,false);
 assert.equal(resourceSchema.safeParse({clientId,title:'File',kind:'file_metadata',fileName:'math.pdf',url:'https://example.com'}).success,false);
 assert.equal(submissionSchema.safeParse({}).success,false);
 assert.equal(reviewSchema.safeParse({status:'assigned'}).success,false);
});
test('student resources and submissions stay staff-only',()=>{
 for(const controller of [AssignmentsController,ResourcesController]) assert.deepEqual(Reflect.getMetadata('palladium.roles',controller),['owner','admin','tutor']);
});
test('PostgreSQL enforces tenant/student resource scope and progress lifecycle', {skip:!process.env.LEARNING_TEST_DATABASE_URL},async()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL=process.env.LEARNING_TEST_DATABASE_URL;
 const db=new Database();if(previous === undefined) delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
 try {
  const role=(await db.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  await db.migrate(fileURLToPath(new URL('../migrations',import.meta.url)));
  const service=new LearningService(db);const ctx:RequestContext={businessId:randomUUID(),sub:'teacher-user',role:'tutor',entitlements:['learning'],requestId:randomUUID()};const other={...ctx,businessId:randomUUID()};
  const resource=await service.createResource(ctx,{clientId,title:'Worksheet',kind:'file_metadata',fileName:'worksheet.pdf'});
  assert.equal(resource.item.storageStatus,'upload_pending');assert.equal(resource.item.url,null);
  await assert.rejects(service.createAssignment(other,{clientId,title:'Foreign',resourceIds:[resource.item.id]}),{status:404});
  await assert.rejects(service.createAssignment(ctx,{clientId:randomUUID(),title:'Wrong student',resourceIds:[resource.item.id]}),{status:404});
  const assignment=await service.createAssignment(ctx,{clientId,title:'Algebra',resourceIds:[resource.item.id]});assert.equal(assignment.item.status,'assigned');
  const learner={...ctx,role:'student' as const,accessScope:'students' as const,studentIds:[clientId]};
  assert.equal((await service.listAssignments(learner,{clientId,status:'actionable'},true)).total,1);
  assert.equal((await service.listAssignments({...learner,studentIds:[randomUUID()]},{status:'actionable'},true)).total,0);
  assert.equal((await service.listAssignments(other,{})).items.length,0);assert.equal((await service.listResources(other,{})).items.length,0);
  await assert.rejects(service.submit(other,assignment.item.id,{submissionText:'Answers'}),{status:404});
  await assert.rejects(service.review(ctx,assignment.item.id,{status:'completed'}),{status:409});
  await service.submit(ctx,assignment.item.id,{submissionText:'First draft'});await service.review(ctx,assignment.item.id,{status:'needs_revision',feedback:'Try again'});
  await service.submit(ctx,assignment.item.id,{submissionText:'Corrected answers'});const complete=await service.review(ctx,assignment.item.id,{status:'completed'});assert.equal(complete.item.status,'completed');assert.deepEqual(complete.item.resourceIds,[resource.item.id]);
  await assert.rejects(service.submit(ctx,assignment.item.id,{submissionText:'Late change'}),{status:409});
  assert.equal((await service.listAssignments(learner,{clientId,status:'actionable'},true)).total,0);
  assert.equal((await service.listAssignments(learner,{clientId,status:'completed'},true)).total,1);
  assert.equal((await db.pool.query('SELECT * FROM resources WHERE id=$1',[resource.item.id])).rows.length,0);
  await db.withTenant(ctx.businessId,async tx=>{await tx.query('DELETE FROM assignment_resources WHERE business_id=$1',[ctx.businessId]);await tx.query('DELETE FROM assignments WHERE business_id=$1',[ctx.businessId]);await tx.query('DELETE FROM resources WHERE business_id=$1',[ctx.businessId]);});
  await db.pool.query("DELETE FROM service_outbox WHERE event->>'businessId'=$1",[ctx.businessId]);
 } finally {await db.pool.end();}
});
