import {Inject,Injectable} from '@nestjs/common';
import {EventBus} from '@palladium/service-kit';
import {z} from 'zod';
import {boardEvent} from './planning.service.js';
@Injectable()
export class PlanningStudentMerges {
 constructor(@Inject(EventBus) private readonly events:EventBus) {}
 onModuleInit() {
  this.events.subscribe('clients.student-merged.v1',async(event,tx)=>{
   if(event.producer!=='clients')throw new Error('Invalid merge producer');
   const input=z.object({sourceId:z.uuid(),targetId:z.uuid(),revision:z.number().int().positive()}).parse(event.data);
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${event.businessId}:planning-merges`]);
   const existing=(await tx.query('SELECT revision FROM planning_student_aliases WHERE source_id=$1',[input.sourceId])).rows[0];
   if(existing&&Number(existing.revision)>=input.revision)return;
   const target=(await tx.query<{id:string}>('SELECT planning_canonical_student($1::uuid) id',[input.targetId])).rows[0]!.id;
   if(target===input.sourceId)throw new Error('Cyclic student merge');
   await tx.query(`INSERT INTO planning_student_aliases(business_id,source_id,target_id,revision) VALUES($1,$2,$3,$4)
    ON CONFLICT(business_id,source_id) DO UPDATE SET target_id=EXCLUDED.target_id,revision=EXCLUDED.revision
    WHERE planning_student_aliases.revision<EXCLUDED.revision`,[event.businessId,input.sourceId,target,input.revision]);
   await tx.query('UPDATE planning_student_aliases SET target_id=planning_canonical_student(target_id) WHERE target_id IS DISTINCT FROM planning_canonical_student(target_id)');
   // All board mutation paths lock the parent board first. Identity corrections
   // retain board ownership/sharing and never create or transfer portal grants.
   const boards=(await tx.query('SELECT * FROM planning_boards WHERE student_id IS DISTINCT FROM planning_canonical_student(student_id) ORDER BY id FOR UPDATE')).rows;
   for(const board of boards){const updated=(await tx.query('UPDATE planning_boards SET student_id=planning_canonical_student(student_id),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[board.id])).rows[0];await boardEvent(tx,{businessId:event.businessId,requestId:event.correlationId},updated);}
  });
 }
}
