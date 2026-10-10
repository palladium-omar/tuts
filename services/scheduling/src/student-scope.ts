import { ConflictException,ForbiddenException,Inject,Injectable } from '@nestjs/common';
import { assertStudentAccess,EventBus } from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {emitClassSnapshot} from './class-ledger.js';
export const isStudentScope=(ctx:RequestContext)=>ctx.accessScope==='students'||['student','parent'].includes(ctx.role);
export async function canonicalStudent(tx:PoolClient,id:string):Promise<string> {
  return (await tx.query<{id:string}>('SELECT scheduling_canonical_student($1::uuid) AS id',[id])).rows[0]!.id;
}
export async function requireStudentScope(tx:PoolClient,ctx:RequestContext,id:string) {
  const canonical=await canonicalStudent(tx,id);
  assertStudentAccess(ctx,canonical);
  return canonical;
}
export async function assertCanonicalOverlap(tx:PoolClient,studentId:string,startsAt:string,endsAt:string,exceptId?:string) {
  const conflicts=await tx.query(`SELECT 1 FROM sessions WHERE status='scheduled' AND scheduling_canonical_student(client_id)=$1
    AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz AND ($4::uuid IS NULL OR id<>$4) LIMIT 1`,[studentId,startsAt,endsAt,exceptId??null]);
  if(conflicts.rowCount) throw new ConflictException('The student already has a scheduled session during this time');
}
@Injectable()
export class StudentAliasConsumer {
  constructor(@Inject(EventBus) private readonly events:EventBus) {}
  onModuleInit() {
    this.events.subscribe('clients.student-merged.v1',async(event,tx)=>{
      if(event.producer!=='clients') throw new Error('Invalid merge producer');
      const input=z.object({sourceId:z.uuid(),targetId:z.uuid(),revision:z.number().int().positive()}).parse(event.data);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${event.businessId}:scheduling`]);
      const existing=(await tx.query<{revision:string}>('SELECT revision FROM scheduling_student_aliases WHERE source_id=$1',[input.sourceId])).rows[0];
      if(existing && Number(existing.revision)>=input.revision) return;
      const target=await canonicalStudent(tx,input.targetId);
      if(target===input.sourceId) throw new Error('Cyclic student merge alias');
      await tx.query(`INSERT INTO scheduling_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(business_id,source_id) DO UPDATE SET target_id=EXCLUDED.target_id,revision=EXCLUDED.revision
        WHERE scheduling_student_aliases.revision<EXCLUDED.revision`,[event.businessId,input.sourceId,target,input.revision]);
      await tx.query('UPDATE scheduling_student_aliases SET target_id=scheduling_canonical_student(target_id) WHERE target_id IS DISTINCT FROM scheduling_canonical_student(target_id)');
      // Keep source session keys unchanged: remapping scheduled rows blindly can
      // violate overlap constraints. Only their canonical read model is updated.
      const changed=await tx.query(`UPDATE class_ledger SET client_id=scheduling_canonical_student(client_id),revision=revision+1,updated_at=now()
        WHERE client_id IS DISTINCT FROM scheduling_canonical_student(client_id) RETURNING *`);
      for(const row of changed.rows) await emitClassSnapshot(tx,event.businessId,row,event.correlationId);
    });
  }
}
