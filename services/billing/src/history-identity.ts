import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {Database, assertPermission, emitEvent, parseBody, serviceFetch} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {z} from 'zod';
import {assertHistoryAccess} from './history.js';
export const reviewSchema=z.object({status:z.enum(['linked','unknown','ambiguous']),studentId:z.uuid().nullable().optional(),expectedWorkRevision:z.number().int().positive(),expectedIdentityRevision:z.number().int().nonnegative(),reason:z.string().trim().max(500).default('')}).strict().refine(value=>value.status==='linked'?Boolean(value.studentId):!value.studentId,'Select a student only for a linked identity');
const studentResponse=z.object({item:z.object({id:z.uuid(),kind:z.literal('student')})});
export function identityView(row:Record<string,any>|undefined,workRevision:number) {
 if(!row?.identity_status)return {status:'unreviewed',studentId:null,revision:0,reason:'',reviewedAt:null};
 const current=Number(row.identity_work_revision)===workRevision;
 return {status:current?row.identity_status:'stale',studentId:current&&row.identity_status==='linked'?row.identity_student_id:null,revision:Number(row.identity_revision),reason:row.identity_reason,reviewedAt:row.identity_reviewed_at};
}
@Injectable()
export class HistoryIdentityService {
 constructor(@Inject(Database)private readonly db:Database){}
 fetchStudent:typeof serviceFetch=serviceFetch;
 private async verifiedStudent(id:string,authorization:unknown){
  if(typeof authorization!=='string'||!/^Bearer \S+$/.test(authorization))throw new BadRequestException('Verified authorization required');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const lookup=async()=>{
    const response=await this.fetchStudent('clients',`/v1/clients/${id}`,{headers:{authorization},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new BadRequestException('Select an accessible canonical CRM student');
    const reader=response.body?.getReader();if(!reader)throw new ServiceUnavailableException('Student verification unavailable');
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw new ServiceUnavailableException('Student verification response exceeds limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    let parsed:unknown;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ServiceUnavailableException('Student verification unavailable');}
    const result=studentResponse.safeParse(parsed);if(!result.success)throw new BadRequestException('Select an accessible canonical CRM student');return result.data.item.id;
   };
   return await Promise.race([lookup(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ServiceUnavailableException('Student verification unavailable')),5000);})]);
  }catch(error){if(error instanceof BadRequestException||error instanceof ServiceUnavailableException)throw error;throw new ServiceUnavailableException('Student verification unavailable');}finally{if(timer)clearTimeout(timer);}
 }
 async review(ctx:RequestContext,id:string,body:unknown,authorization:unknown){
  assertHistoryAccess(ctx,true);parseBody(z.uuid(),id);const input=parseBody(reviewSchema,body);
  let verified:string|null=null;
  if(input.status==='linked'){
   assertPermission(ctx,'clients.read');if(!ctx.entitlements.includes('clients'))throw new ForbiddenException('Clients is not enabled for this business');
   verified=await this.verifiedStudent(input.studentId!,authorization);
  }
  return this.db.withTenant(ctx.businessId,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`monthly:${ctx.businessId}`]);
   const work=(await tx.query('SELECT revision FROM billing_work_log WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!work)throw new NotFoundException('work_log_not_found');
   if(work.revision!==input.expectedWorkRevision)throw new ConflictException('work_log_revision_conflict');
   const current=(await tx.query('SELECT revision FROM billing_work_identities WHERE work_id=$1',[id])).rows[0];
   if(Number(current?.revision??0)!==input.expectedIdentityRevision)throw new ConflictException('identity_review_revision_conflict');
   const studentId=verified?(await tx.query('SELECT billing_student_root($1) id',[verified])).rows[0].id:null;
   const result=await tx.query(`INSERT INTO billing_work_identities(business_id,work_id,student_id,status,work_revision,reason,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(business_id,work_id) DO UPDATE SET student_id=EXCLUDED.student_id,status=EXCLUDED.status,work_revision=EXCLUDED.work_revision,reason=EXCLUDED.reason,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now(),revision=billing_work_identities.revision+1
    RETURNING status identity_status,student_id identity_student_id,work_revision identity_work_revision,revision identity_revision,reason identity_reason,reviewed_at identity_reviewed_at`,[ctx.businessId,id,studentId,input.status,work.revision,input.reason,ctx.sub]);
   await emitEvent(tx,{type:'billing.work-history-updated.v1',producer:'billing',businessId:ctx.businessId,correlationId:ctx.requestId,data:{id,identityRevision:result.rows[0].identity_revision}});
   return {workId:id,...identityView(result.rows[0],work.revision)};
  });
 }
}
