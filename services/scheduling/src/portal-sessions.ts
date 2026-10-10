import {BadRequestException,Controller,Get,Header,Inject,Injectable,Query} from '@nestjs/common';
import {CurrentContext,Database,Permissions,Roles,StudentScoped,parseBody} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {emitClassSnapshot,ledgerColumns,ledgerItem,ledgerUpsert,sourceUnion,normalizeLegacyAttendance} from './class-ledger.js';
import {isStudentScope,requireStudentScope} from './student-scope.js';
const pagination={studentId:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(200).default(100),offset:z.coerce.number().int().min(0).max(100000).default(0)};
const range=z.object({...pagination,from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional()}).strict().superRefine((v,c)=>{
  if(Boolean(v.from)!==Boolean(v.to) || (v.from && v.to && (Date.parse(v.to)<=Date.parse(v.from)||Date.parse(v.to)-Date.parse(v.from)>93*86400000)))
    c.addIssue({code:'custom',message:'Provide a paired range of at most 93 days'});
});
const month=z.object({...pagination,studentId:z.uuid(),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(v=>Number(v.slice(0,4))>=2000 && Number(v.slice(0,4))<=2200),timeZone:z.string().max(100).default('UTC').refine(v=>{
  try {new Intl.DateTimeFormat('en',{timeZone:v});return true;} catch{return false;}
})}).strict();
@Injectable()
export class PortalSessionsService {
  constructor(@Inject(Database) private readonly db:Database) {}
  private async read(tx:PoolClient,ctx:RequestContext,where:string,values:unknown[],limit:number,offset:number) {
    const sourceTotal=Number((await tx.query(`SELECT count(*) AS total FROM (${sourceUnion}) s WHERE ${where}`,values)).rows[0].total);
    if(sourceTotal>10000) throw new BadRequestException('This session range exceeds 10000 classes; choose a smaller range');
    const changed=await tx.query(`INSERT INTO class_ledger(${ledgerColumns}) SELECT ${ledgerColumns} FROM (${sourceUnion}) s
      WHERE ${where} LIMIT 10001 ${ledgerUpsert}`,values);
    for(const row of changed.rows) await emitClassSnapshot(tx,ctx.businessId,row,ctx.requestId);
    const total=Number((await tx.query(`SELECT count(*) AS total FROM class_ledger WHERE ${where}`,values)).rows[0].total);
    if(total>10000) throw new BadRequestException('This session range exceeds 10000 classes; choose a smaller range');
    await normalizeLegacyAttendance(tx,ctx.businessId,where,values,ctx.requestId);
    const rows=(await tx.query(`SELECT l.*,e.booking_url FROM class_ledger l LEFT JOIN external_sessions e
      ON e.business_id=l.business_id AND l.source='external' AND e.id=l.class_id
      WHERE ${where.replaceAll('client_id','l.client_id').replaceAll('starts_at','l.starts_at').replaceAll('ends_at','l.ends_at')}
      ORDER BY l.starts_at,l.source,l.class_id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,limit,offset])).rows;
    return {items:rows.map(row=>{
      const item=ledgerItem(row);
      return {...item,attendeeEmail:undefined,bookingUrl:row.booking_url??null,readOnly:true};
    }),total,limit,offset};
  }
  async sessions(ctx:RequestContext,query:unknown) {
    const input=parseBody(range,query);
    return this.db.withTenant(ctx.businessId,async tx=>{
      const studentId=input.studentId ? await requireStudentScope(tx,ctx,input.studentId) : null;
      const from=input.from??new Date(Date.now()-31*86400000).toISOString();
      const to=input.to??new Date(Date.parse(from)+93*86400000).toISOString();
      const result=await this.read(tx,ctx,`($1::boolean OR client_id=ANY($2::uuid[])) AND ($3::uuid IS NULL OR client_id=$3)
        AND starts_at<$5::timestamptz AND ends_at>$4::timestamptz`,[!isStudentScope(ctx),ctx.studentIds??[],studentId,from,to],input.limit,input.offset);
      return {...result,from,to};
    });
  }
  async classes(ctx:RequestContext,query:unknown) {
    const input=parseBody(month,query);
    return this.db.withTenant(ctx.businessId,async tx=>{
      const studentId=await requireStudentScope(tx,ctx,input.studentId);
      const result=await this.read(tx,ctx,`client_id=$1 AND (starts_at AT TIME ZONE $3)::date >= $2::date
        AND (starts_at AT TIME ZONE $3)::date < ($2::date+interval '1 month')`,[studentId,`${input.month}-01`,input.timeZone],input.limit,input.offset);
      return {...result,month:input.month,timeZone:input.timeZone};
    });
  }
}
@StudentScoped() @Roles('owner','admin','tutor','student','parent') @Permissions('scheduling.read')
@Controller('v1/portal')
export class PortalSessionsController {
  constructor(@Inject(PortalSessionsService) private readonly service:PortalSessionsService) {}
  @Get('sessions') @Header('Cache-Control','no-store')
  sessions(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.sessions(ctx,query);}
  @Get('classes') @Header('Cache-Control','no-store')
  classes(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.classes(ctx,query);}
}
