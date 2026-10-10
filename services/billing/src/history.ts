import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Database, assertPermission, emitEvent, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idempotent, requestHash } from './idempotency.js';
import { monthSchema } from './monthly.js';
import { historyHours, historyOptionsSchema, historyStatus, parseHistoryDate, parseHistoryFile, workAmount, type HistoryPreview, type HistoryValues, type RawSheet } from './history-parser.js';

const uuid=z.uuid();
export const historyQuerySchema=z.object({month:monthSchema.optional(),status:z.union([historyStatus,z.literal('unpaid')]).optional(),search:z.string().max(200).default(''),limit:z.coerce.number().int().min(1).max(200).default(50),offset:z.coerce.number().int().min(0).max(100000).default(0)}).strict();
const summaryQuerySchema=historyQuerySchema.pick({month:true,status:true,search:true});
const dateSchema=z.string().refine(value=>parseHistoryDate(value)===value,'Use a valid YYYY-MM-DD date');
const amountSchema=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commonFields={date:dateSchema,studentName:z.string().trim().min(1).max(200),serviceType:z.string().trim().max(500).default(''),amountMinor:amountSchema,currency:z.string().regex(/^[A-Z]{3}$/),status:historyStatus,paidDate:dateSchema.nullable().optional(),invoiceNumber:z.string().trim().min(1).max(200).nullable().optional(),notes:z.string().max(4000).default('')};
const manualInvoiceSchema=z.object({...commonFields,importId:uuid.optional()}).strict();
const workPatchSchema=z.object({...commonFields,hours:z.number().positive().max(1000000).refine(v=>historyHours(v)!==undefined),rateMinor:amountSchema,countAsClasses:z.boolean(),revision:z.number().int().positive().optional()}).partial().strict().refine(v=>Object.keys(v).some(key=>key!=='revision'),'Provide a correction');
const invoicePatchSchema=z.object({status:historyStatus.optional(),paidDate:dateSchema.nullable().optional(),revision:z.number().int().positive().optional()}).strict().refine(v=>v.status!==undefined||v.paidDate!==undefined,'Provide status or paid date');
const commitSchema=z.object({token:uuid,allowPartial:z.boolean().default(false)}).strict();

export function assertHistoryAccess(ctx:RequestContext,write=false) {
  if(!['owner','admin','tutor'].includes(ctx.role)||ctx.accessScope==='students')throw new ForbiddenException('Business history requires business access');
  assertPermission(ctx,'billing.read');assertPermission(ctx,'reporting.financial');if(write)assertPermission(ctx,'billing.write');
}
export function safeHistoryMinor(value:unknown):number {
  const n=Number(value);if(!Number.isSafeInteger(n)||n<0||!/^\d+$/.test(String(value)))throw new UnprocessableEntityException('Aggregate exceeds the supported exact monetary range');return n;
}
export const dayView=(value:unknown):string=>value instanceof Date?`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`:String(value).slice(0,10);
export function historyRecord(row:Record<string,any>,kind:'work'|'invoices') {
  return {id:row.id,origin:'imported',importId:row.import_id??null,sourceRow:row.source_row??null,date:dayView(kind==='work'?row.work_date:row.invoice_date),studentName:row.student_name,serviceType:row.service_type,invoiceNumber:row.invoice_number??null,amountMinor:safeHistoryMinor(row.amount_minor),currency:row.currency,status:row.status,paidDate:row.paid_date?dayView(row.paid_date):null,notes:row.notes,revision:row.revision,rawColumns:row.raw_columns,paymentEvidence:row.status==='paid'?'historical_declaration':'none',createdAt:row.created_at,updatedAt:row.updated_at,...(kind==='work'?{hours:Number(row.hours),rateMinor:safeHistoryMinor(row.rate_minor),countAsClasses:row.count_as_classes}:{})};
}
export const sourceRecord=(row:Record<string,any>)=>({id:row.id,fileName:row.file_name,kind:row.kind,status:row.committed_at?'committed':'staged',contentType:row.content_type,sizeBytes:Number(row.size_bytes),createdAt:row.created_at,committedAt:row.committed_at??null,summary:row.preview?.summary??null,sheetName:row.preview?.sheetName??null,downloadPath:`/billing/v1/history-imports/${row.id}/download`});
function filters(input:z.infer<typeof historyQuerySchema>|z.infer<typeof summaryQuerySchema>,dateField:string,nameField:string,alias='') {
  const values:unknown[]=[],clauses:string[]=[];const prefix=alias?`${alias}.`:'';
  if(input.month){values.push(`${input.month}-01`);clauses.push(`${prefix}${dateField}>=$${values.length}::date AND ${prefix}${dateField}<($${values.length}::date+INTERVAL '1 month')`);}
  if(input.status==='unpaid')clauses.push(`${prefix}status IN ('unsent','pending')`);else if(input.status){values.push(input.status);clauses.push(`${prefix}status=$${values.length}`);}
  if(input.search){values.push(`%${input.search.replace(/[\\%_]/g,v=>`\\${v}`)}%`);clauses.push(`(${prefix}${nameField} ILIKE $${values.length} OR ${prefix}notes ILIKE $${values.length} OR COALESCE(${prefix}invoice_number,'') ILIKE $${values.length})`);}
  return {values,where:clauses.length?`WHERE ${clauses.join(' AND ')}`:''};
}
function paidDateValid(status:string,paidDate:unknown){if(status!=='paid'&&paidDate)throw new BadRequestException('Paid date requires a historical paid declaration');}
async function existingInvoiceNumbers(tx:PoolClient,numbers:string[]) {
  if(!numbers.length)return new Set<string>();
  const normalized=[...new Set(numbers.map(number=>number.trim().toLowerCase()))];
  const collision=await tx.query(`SELECT lower(btrim(invoice_number)) number FROM billing_invoice_history WHERE lower(btrim(invoice_number))=ANY($1::text[]) UNION ALL SELECT id::text number FROM invoices WHERE id::text=ANY($1::text[])`,[normalized]);
  return new Set<string>(collision.rows.map(row=>row.number));
}
async function checkInvoiceNumber(tx:PoolClient,number:string|undefined|null) {
  if(number&&(await existingInvoiceNumbers(tx,[number])).size)throw new ConflictException('invoice_number_already_recorded_review_duplicate');
}
@Injectable()
export class HistoryService {
  constructor(@Inject(Database) private readonly db:Database) {}
  async preview(ctx:RequestContext,file:{originalname:string;buffer:Buffer}|undefined,rawOptions:unknown) {
    assertHistoryAccess(ctx,true);if(!file)throw new BadRequestException('Attach one CSV, XLSX or PDF file');
    let optionsInput=rawOptions??{};
    if(typeof optionsInput==='string'){try{optionsInput=JSON.parse(optionsInput);}catch{throw new BadRequestException('Options must be valid JSON');}}
    const options=parseBody(historyOptionsSchema,optionsInput);
    const parsed=await parseHistoryFile(file.originalname,file.buffer,options);
    const contentHash=createHash('sha256').update(file.buffer).digest('hex'),optionsHash=requestHash(options);
    return this.db.withTenant(ctx.businessId,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`history:${ctx.businessId}`]);
      const existing=await tx.query('SELECT id,token,preview FROM billing_history_sources WHERE business_id=$1 AND content_hash=$2 AND options_hash=$3',[ctx.businessId,contentHash,optionsHash]);
      if(existing.rows[0])return {...existing.rows[0].preview,token:existing.rows[0].token,importId:existing.rows[0].id};
      const preview=parsed.preview;
      if(preview.kind==='invoices') {
        const seen=new Set<string>();
        const existingNumbers=await existingInvoiceNumbers(tx,preview.rows.flatMap(row=>row.values.invoiceNumber?[row.values.invoiceNumber]:[]));
        for(const row of preview.rows)if(row.values.invoiceNumber){
          const key=row.values.invoiceNumber.toLowerCase().trim();
          if(seen.has(key))row.errors.push('Duplicate invoice number in this file');
          if(existingNumbers.has(key))row.errors.push('Invoice number is already recorded; review the duplicate');
          seen.add(key);
        }
        preview.summary.valid=preview.rows.filter(r=>!r.errors.length).length;preview.summary.invalid=preview.rows.filter(r=>r.errors.length).length;
      }
      const id=randomUUID(),token=randomUUID();
      await tx.query(`INSERT INTO billing_history_sources(business_id,id,token,content_hash,options_hash,file_name,content_type,file_bytes,options,raw_source,preview,kind,staged_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)`,[ctx.businessId,id,token,contentHash,optionsHash,preview.fileName,parsed.contentType,file.buffer,JSON.stringify(options),JSON.stringify(parsed.rawSource),JSON.stringify(preview),preview.kind,ctx.sub]);
      await emitEvent(tx,{type:'billing.history-staged.v1',producer:'billing',businessId:ctx.businessId,correlationId:ctx.requestId,data:{importId:id,kind:preview.kind,valid:preview.summary.valid,invalid:preview.summary.invalid}});
      return {...preview,token,importId:id};
    });
  }
  async commit(ctx:RequestContext,body:unknown,key:unknown) {
    assertHistoryAccess(ctx,true);const input=parseBody(commitSchema,body);
    return this.db.withTenant(ctx.businessId,tx=>idempotent(tx,ctx.businessId,'history.commit',key,input,async()=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`history:${ctx.businessId}`]);
      const selected=await tx.query('SELECT * FROM billing_history_sources WHERE business_id=$1 AND token=$2 FOR UPDATE',[ctx.businessId,input.token]);
      const source=selected.rows[0];if(!source)throw new NotFoundException('history_stage_not_found');
      if(source.committed_at)return source.commit_result;
      const duplicate=await tx.query('SELECT id FROM billing_history_sources WHERE business_id=$1 AND content_hash=$2 AND kind=$3 AND committed_at IS NOT NULL AND id<>$4',[ctx.businessId,source.content_hash,source.kind,source.id]);
      if(duplicate.rows[0])throw new ConflictException('source_already_imported_with_other_options');
      const preview=source.preview as HistoryPreview;
      if(preview.summary.invalid&&!input.allowPartial)throw new ConflictException({message:'Review row errors or explicitly allow partial import',summary:preview.summary});
      if(preview.kind!=='archive'&&!preview.summary.valid)throw new BadRequestException('No valid rows to import; review mapping and row errors');
      const sheet=(source.raw_source.sheets as RawSheet[]).find(s=>s.name===preview.sheetName);
      const rawByRow=new Map(sheet?.rows.map(row=>[row.rowNumber,row.columns])??[]);
      const records=preview.rows.filter(row=>!row.errors.length).map(row=>{
        const v=row.values as Required<Pick<HistoryValues,'date'|'studentName'|'currency'|'amountMinor'|'status'>>&HistoryValues;
        return {id:randomUUID(),import_id:source.id,source_row:row.rowNumber,date:v.date,student_name:v.studentName,service_type:v.serviceType??'',hours:v.hours,rate_minor:v.rateMinor,amount_minor:v.amountMinor,currency:v.currency,status:v.status,paid_date:v.paidDate??null,invoice_number:v.invoiceNumber??null,notes:v.notes??'',count_as_classes:source.options.countAsClasses??false,raw_columns:rawByRow.get(row.rowNumber)??{}};
      });
      if(preview.kind==='work')await tx.query(`INSERT INTO billing_work_log(business_id,id,import_id,source_row,work_date,student_name,service_type,hours,rate_minor,amount_minor,currency,status,paid_date,invoice_number,notes,count_as_classes,raw_columns)
        SELECT $1,id,import_id,source_row,date,student_name,service_type,hours,rate_minor,amount_minor,currency,status,paid_date,invoice_number,notes,count_as_classes,raw_columns
        FROM jsonb_to_recordset($2::jsonb) AS data(id uuid,import_id uuid,source_row integer,date date,student_name text,service_type text,hours numeric,rate_minor bigint,amount_minor bigint,currency text,status text,paid_date date,invoice_number text,notes text,count_as_classes boolean,raw_columns jsonb)`,[ctx.businessId,JSON.stringify(records)]);
      else if(preview.kind==='invoices'){
        if((await existingInvoiceNumbers(tx,records.flatMap(row=>row.invoice_number?[row.invoice_number]:[]))).size)throw new ConflictException('invoice_number_already_recorded_review_duplicate');
        await tx.query(`INSERT INTO billing_invoice_history(business_id,id,import_id,source_row,invoice_date,student_name,service_type,invoice_number,amount_minor,currency,status,paid_date,notes,raw_columns)
          SELECT $1,id,import_id,source_row,date,student_name,service_type,invoice_number,amount_minor,currency,status,paid_date,notes,raw_columns
          FROM jsonb_to_recordset($2::jsonb) AS data(id uuid,import_id uuid,source_row integer,date date,student_name text,service_type text,invoice_number text,amount_minor bigint,currency text,status text,paid_date date,notes text,raw_columns jsonb)`,[ctx.businessId,JSON.stringify(records)]);
      }
      const imported=records.length;
      const result={importId:source.id,kind:preview.kind,imported,invalid:preview.summary.invalid,skipped:preview.summary.skipped,partial:preview.summary.invalid>0,committedAt:new Date().toISOString()};
      await tx.query('UPDATE billing_history_sources SET committed_at=$3,commit_result=$4::jsonb WHERE business_id=$1 AND id=$2',[ctx.businessId,source.id,result.committedAt,JSON.stringify(result)]);
      await emitEvent(tx,{type:'billing.history-imported.v1',producer:'billing',businessId:ctx.businessId,correlationId:ctx.requestId,data:result});return result;
    }));
  }
  async sources(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(historyQuerySchema.pick({limit:true,offset:true}),query);
    return this.db.withTenant(ctx.businessId,async tx=>{
      const count=await tx.query('SELECT count(*) total FROM billing_history_sources');
      const rows=await tx.query('SELECT id,file_name,kind,content_type,octet_length(file_bytes) size_bytes,created_at,committed_at,preview FROM billing_history_sources ORDER BY created_at DESC,id LIMIT $1 OFFSET $2',[input.limit,input.offset]);
      return {items:rows.rows.map(sourceRecord),total:Number(count.rows[0].total),limit:input.limit,offset:input.offset};
    });
  }
  async download(ctx:RequestContext,id:string) {
    assertHistoryAccess(ctx);parseBody(uuid,id);return this.db.withTenant(ctx.businessId,async tx=>{
      const rows=await tx.query('SELECT file_name,content_type,file_bytes FROM billing_history_sources WHERE business_id=$1 AND id=$2',[ctx.businessId,id]);
      if(!rows.rows[0])throw new NotFoundException('history_source_not_found');return rows.rows[0] as {file_name:string;content_type:string;file_bytes:Buffer};
    });
  }
  async workLog(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(historyQuerySchema,query),filter=filters(input,'work_date','student_name');
    return this.db.withTenant(ctx.businessId,async tx=>{
      const count=await tx.query(`SELECT count(*) total FROM billing_work_log ${filter.where}`,filter.values);
      const selected=await tx.query(`SELECT * FROM billing_work_log ${filter.where} ORDER BY work_date DESC,id LIMIT $${filter.values.length+1} OFFSET $${filter.values.length+2}`,[...filter.values,input.limit,input.offset]);
      return {items:selected.rows.map(row=>historyRecord(row,'work')),total:Number(count.rows[0].total),limit:input.limit,offset:input.offset};
    });
  }
  async workSummary(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(summaryQuerySchema,query),filter=filters(input,'work_date','student_name');
    return this.db.withTenant(ctx.businessId,async tx=>{
      const aggregate=`sum(hours) hours,sum(amount_minor) total,COALESCE(sum(amount_minor) FILTER(WHERE status='unsent'),0) unsent,COALESCE(sum(amount_minor) FILTER(WHERE status='pending'),0) pending,COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0) paid`;
      const [students,currencies]=await Promise.all([tx.query(`SELECT student_name,currency,max(work_date) last_date,${aggregate} FROM billing_work_log ${filter.where} GROUP BY student_name,currency ORDER BY student_name,currency`,filter.values),tx.query(`SELECT currency,${aggregate} FROM billing_work_log ${filter.where} GROUP BY currency ORDER BY currency`,filter.values)]);
      const measures=(row:Record<string,any>)=>({currency:row.currency,totalHours:Number(row.hours),totalMinor:safeHistoryMinor(row.total),unsentMinor:safeHistoryMinor(row.unsent),pendingMinor:safeHistoryMinor(row.pending),paidMinor:safeHistoryMinor(row.paid)});
      return {students:students.rows.map(row=>({...measures(row),studentName:row.student_name,lastDate:dayView(row.last_date)})),currencies:currencies.rows.map(measures)};
    });
  }
  async editWork(ctx:RequestContext,id:string,body:unknown) {
    assertHistoryAccess(ctx,true);parseBody(uuid,id);const patch=parseBody(workPatchSchema,body);
    return this.db.withTenant(ctx.businessId,async tx=>{
      const selected=await tx.query('SELECT * FROM billing_work_log WHERE business_id=$1 AND id=$2 FOR UPDATE',[ctx.businessId,id]);const row=selected.rows[0];if(!row)throw new NotFoundException('work_log_not_found');
      if(patch.revision!==undefined&&patch.revision!==row.revision)throw new ConflictException('work_log_revision_conflict');
      const current=historyRecord(row,'work');const next={...current,...patch};
      if(patch.status!==undefined&&patch.status!=='paid'&&patch.paidDate===undefined)next.paidDate=null;
      paidDateValid(next.status,next.paidDate);
      const derived=workAmount(next.hours,next.rateMinor!);if(derived===undefined)throw new BadRequestException('Calculated total exceeds exact range');
      if(patch.hours!==undefined||patch.rateMinor!==undefined){if(patch.amountMinor!==undefined&&patch.amountMinor!==derived)throw new BadRequestException('Total conflicts with corrected hours × rate');next.amountMinor=derived;}
      else if(patch.amountMinor!==undefined&&patch.amountMinor!==derived)throw new BadRequestException('Total conflicts with hours × rate');
      const updated=await tx.query(`UPDATE billing_work_log SET work_date=$3,student_name=$4,service_type=$5,hours=$6,rate_minor=$7,amount_minor=$8,currency=$9,status=$10,paid_date=$11,invoice_number=$12,notes=$13,count_as_classes=$14,revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,[ctx.businessId,id,next.date,next.studentName,next.serviceType,next.hours,next.rateMinor,next.amountMinor,next.currency,next.status,next.paidDate,next.invoiceNumber,next.notes,next.countAsClasses]);
      await emitEvent(tx,{type:'billing.work-history-updated.v1',producer:'billing',businessId:ctx.businessId,correlationId:ctx.requestId,data:{id,revision:updated.rows[0].revision}});return historyRecord(updated.rows[0],'work');
    });
  }
  async invoiceHistory(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(historyQuerySchema,query);
    return this.db.withTenant(ctx.businessId,async tx=>{
      const tz=(await tx.query('SELECT time_zone FROM billing_settings LIMIT 1')).rows[0]?.time_zone??'UTC';
      // Native invoices remain unchanged: union only supplies a read projection.
      const cte=`WITH history AS (
        SELECT id,'imported' origin,import_id,source_row,invoice_date date,student_name,service_type,invoice_number,amount_minor,currency,status,paid_date,notes,revision,raw_columns,created_at,updated_at,NULL::uuid client_id,CASE WHEN status='paid' THEN amount_minor ELSE 0 END paid_minor,0::bigint simulated_minor,CASE WHEN status='paid' THEN 'historical_declaration' ELSE 'none' END payment_evidence FROM billing_invoice_history
        UNION ALL SELECT i.id,'native',NULL::uuid,NULL::integer,COALESCE(i.service_month,(COALESCE(i.issued_at,i.created_at) AT TIME ZONE $1)::date),i.payer_name,'',NULL::text,i.total_minor,i.currency,CASE i.status WHEN 'draft' THEN 'unsent' WHEN 'settled' THEN 'paid' ELSE 'pending' END,NULL::date,'',i.revision,'{}'::jsonb,i.created_at,i.created_at,i.client_id,COALESCE(p.real_paid,0),COALESCE(p.simulated_paid,0),CASE WHEN COALESCE(p.simulated_paid,0)>0 THEN 'simulated' WHEN COALESCE(p.real_paid,0)>0 THEN 'verified_processor' ELSE 'none' END FROM invoices i LEFT JOIN (SELECT invoice_id,sum(amount_minor) FILTER(WHERE NOT simulated) real_paid,sum(amount_minor) FILTER(WHERE simulated) simulated_paid FROM payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
      )`;
      const filter=filters(input,'date','student_name');const shifted=filter.where.replace(/\$(\d+)/g,(_,n)=>`$${Number(n)+1}`),values=[tz,...filter.values];
      const count=await tx.query(`${cte} SELECT count(*) total FROM history ${shifted}`,values);
      const result=await tx.query(`${cte} SELECT * FROM history ${shifted} ORDER BY date DESC,id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,input.limit,input.offset]);
      return {items:result.rows.map(row=>({...historyRecord({...row,invoice_date:row.date},'invoices'),origin:row.origin,clientId:row.client_id,paymentEvidence:row.payment_evidence,paidMinor:safeHistoryMinor(row.paid_minor),simulatedMinor:safeHistoryMinor(row.simulated_minor),editable:row.origin==='imported'})),total:Number(count.rows[0].total),limit:input.limit,offset:input.offset};
    });
  }
  async manualInvoice(ctx:RequestContext,body:unknown,key:unknown) {
    assertHistoryAccess(ctx,true);const input=parseBody(manualInvoiceSchema,body);paidDateValid(input.status,input.paidDate);
    return this.db.withTenant(ctx.businessId,tx=>idempotent(tx,ctx.businessId,'history.invoice.create',key,input,async()=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`history:${ctx.businessId}`]);
      if(input.importId){const source=await tx.query('SELECT id FROM billing_history_sources WHERE business_id=$1 AND id=$2',[ctx.businessId,input.importId]);if(!source.rows[0])throw new NotFoundException('history_source_not_found');}
      await checkInvoiceNumber(tx,input.invoiceNumber);
      const inserted=await tx.query(`INSERT INTO billing_invoice_history(business_id,id,import_id,invoice_date,student_name,service_type,invoice_number,amount_minor,currency,status,paid_date,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[ctx.businessId,randomUUID(),input.importId??null,input.date,input.studentName,input.serviceType,input.invoiceNumber??null,input.amountMinor,input.currency,input.status,input.paidDate??null,input.notes]);
      await emitEvent(tx,{type:'billing.invoice-history-recorded.v1',producer:'billing',businessId:ctx.businessId,correlationId:ctx.requestId,data:{id:inserted.rows[0].id,importId:input.importId??null}});return historyRecord(inserted.rows[0],'invoices');
    }));
  }
  async editInvoice(ctx:RequestContext,id:string,body:unknown) {
    assertHistoryAccess(ctx,true);parseBody(uuid,id);const patch=parseBody(invoicePatchSchema,body);
    return this.db.withTenant(ctx.businessId,async tx=>{
      const selected=await tx.query('SELECT * FROM billing_invoice_history WHERE business_id=$1 AND id=$2 FOR UPDATE',[ctx.businessId,id]);const row=selected.rows[0];if(!row)throw new NotFoundException('Imported invoice not found; native invoices are immutable through history');
      if(patch.revision!==undefined&&patch.revision!==row.revision)throw new ConflictException('invoice_history_revision_conflict');
      const status=patch.status??row.status,paidDate=patch.paidDate===undefined?(status==='paid'?row.paid_date:null):patch.paidDate;paidDateValid(status,paidDate);
      const updated=await tx.query('UPDATE billing_invoice_history SET status=$3,paid_date=$4,revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',[ctx.businessId,id,status,paidDate]);
      await emitEvent(tx,{type:'billing.invoice-history-updated.v1',producer:'billing',businessId:ctx.businessId,correlationId:ctx.requestId,data:{id,revision:updated.rows[0].revision}});return historyRecord(updated.rows[0],'invoices');
    });
  }
}
