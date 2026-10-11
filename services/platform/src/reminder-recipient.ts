import {createHash, timingSafeEqual, randomUUID} from 'node:crypto';
import {Body, Controller, Headers, HttpCode, Inject, Injectable, Post, ForbiddenException, UnauthorizedException, ServiceUnavailableException} from '@nestjs/common';
import {ApiExcludeController} from '@nestjs/swagger';
import {assertStudentAccess, Database, Public, parseBody, serviceFetch} from '@palladium/service-kit';
import {hasPermission} from '@palladium/contracts';
import {z} from 'zod';
import {IdentityService} from './identity.service.js';
export const recipientRequestSchema=z.object({businessId:z.uuid(),userId:z.string().min(1).max(200),studentId:z.uuid(),targetKind:z.enum(['homework','planning']).optional(),operation:z.enum(['read','write','delivery'])}).strict();
export function assertReminderSecret(supplied:unknown) {
 const expected=process.env.AUTH_MAIL_INTERNAL_SECRET??'';
 const valid=/^[A-Za-z0-9+/_=-]{32,512}$/;
 if(typeof supplied!=='string'||!valid.test(supplied)||!valid.test(expected)||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(expected).digest()))throw new UnauthorizedException('Internal authorization required');
}
@Injectable()
export class ReminderRecipientService {
 constructor(@Inject(Database) private readonly db:Database,@Inject(IdentityService) private readonly identity:IdentityService){}
 async resolve(input:z.infer<typeof recipientRequestSchema>) {
  return this.db.withTenant(input.businessId,async tx=>{
   const policy=await this.identity.requireBusinessContext({user:{id:input.userId}},input.businessId,tx);
   const permission=input.operation==='read'?'notifications.read':'notifications.write';
   if(!['student','parent'].includes(policy.role)||policy.accessScope!=='students'||!policy.entitlements.includes('notifications')||!policy.entitlements.includes('clients')||!hasPermission(policy,permission))throw new ForbiddenException('Reminder access is unavailable');
   assertStudentAccess({...policy,requestId:randomUUID()},input.studentId);
   if(input.targetKind) {
    const resource=input.targetKind==='homework'?'learning':'planning';
    if(!policy.entitlements.includes(resource)||!hasPermission(policy,`${resource}.read`))throw new ForbiddenException('Reminder resource access is unavailable');
   }
   // Check the persisted grant explicitly, even if a future policy preset changes.
   const account=(await tx.query<{email:string}>(`SELECT u.email FROM "user" u JOIN portal_student_access a ON a.user_id=u.id WHERE a.user_id=$1 AND a.student_id=$2 AND a.revoked_at IS NULL`,[input.userId,input.studentId])).rows[0];
   if(!account||!z.email().max(254).safeParse(account.email).success)throw new ForbiddenException('Reminder access is unavailable');
   const secret=process.env.PORTAL_INTERNAL_SECRET;
   if(!secret||secret.length<32)throw new ServiceUnavailableException('Student validation is unavailable');
   try {
    const response=await serviceFetch('clients','/internal/portal-students',{method:'POST',headers:{'Content-Type':'application/json','X-Portal-Internal-Secret':secret},body:JSON.stringify({businessId:input.businessId,studentId:input.studentId,protect:true}),signal:AbortSignal.timeout(5000)});
    if(response.status===404||response.status===409)throw new ForbiddenException('Reminder student access is unavailable');
    if(!response.ok)throw new ServiceUnavailableException('Student validation is unavailable');
    const value=z.object({item:z.object({id:z.uuid()})}).parse(await response.json());
    if(value.item.id!==input.studentId)throw new ForbiddenException('Reminder student identity changed');
   } catch(error) {
    if(error instanceof ForbiddenException||error instanceof ServiceUnavailableException)throw error;
    throw new ServiceUnavailableException('Student validation is unavailable');
   }
   return {item:{recipientEmail:account.email}};
  });
 }
}
@Public()
@ApiExcludeController()
@Controller('internal/reminder-recipient')
export class ReminderRecipientController {
 constructor(@Inject(ReminderRecipientService)private readonly recipients:ReminderRecipientService){}
 @Post() @HttpCode(200)
 resolve(@Headers('x-auth-mail-secret')secret:unknown,@Body()body:unknown){assertReminderSecret(secret);return this.recipients.resolve(parseBody(recipientRequestSchema,body));}
}
