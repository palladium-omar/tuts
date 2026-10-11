import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, Injectable, NotFoundException, Param, Post, Query, ServiceUnavailableException, type OnModuleInit } from '@nestjs/common';
import { CurrentContext, Database, EventBus, Permissions, Roles, assertPermission, parseBody, serviceFetch } from '@palladium/service-kit';
import { confirmedReceiptSchema, confirmedReceiptsResponseSchema, reconciliationDecisionSchema, type RequestContext, type ReconciliationDecision } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assertHistoryAccess, dayView, safeHistoryMinor } from './history.js';
import { allocateReceipt, adjustInvoice, ensureReconciliation, reconciliationClaimsCte, reconciliationNeedsProjection, importConfirmedReceipts, previewDecision, publishDecision, recordHistoricalReceipt } from './reconciliation-engine.js';

const page = { limit:z.coerce.number().int().min(1).max(200).default(50),offset:z.coerce.number().int().min(0).max(100000).default(0) };
const listSchema=z.object({...page,state:z.enum(['unresolved','accepted']).default('unresolved'),search:z.string().trim().max(200).default('')}).strict();
const receiptsQuery=z.object({...page,currency:z.string().regex(/^[A-Z]{3}$/).optional()}).strict();
const syncSchema=z.object({...page,confirmed:z.literal(true)}).strict();
const amount=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency=z.string().regex(/^[A-Z]{3}$/);
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;});
const receiptSchema=z.object({amountMinor:amount,currency,paidOn:day,reference:z.string().trim().min(1).max(200),reason:z.string().trim().min(1).max(500),confirmed:z.literal(true)}).strict();
const allocationSchema=z.object({receiptId:z.uuid(),invoiceId:z.uuid(),amountMinor:amount,currency,confirmed:z.literal(true)}).strict();
const adjustmentSchema=z.object({invoiceId:z.uuid(),kind:z.enum(['credit','refund']),receiptId:z.uuid().optional(),amountMinor:amount,currency,reason:z.string().trim().min(1).max(500),occurredOn:day,confirmed:z.literal(true)}).strict();
const identitySchema=z.object({item:z.object({id:z.uuid(),kind:z.enum(['student','payer'])})});
const balanceSelection=`WITH ${reconciliationClaimsCte} SELECT i.*,i.verified_paid_minor verified_minor,i.balance_minor outstanding_minor FROM reconciliation_invoice_claims i`;
const sourceView=(kind:string,id:string,revision:number)=>({kind,id,revision});
function invoiceView(row:Record<string,any>) {
  const snapshot=row.source_snapshot??{};
  return {id:row.id,origin:row.origin_kind,source:sourceView(row.origin_kind,row.origin_id,Number(row.source_revision)),status:row.status,invoiceNumber:snapshot.invoice_number??null,amountMinor:safeHistoryMinor(row.face_minor),currency:row.currency,invoiceDate:dayView(row.invoice_date),dueDate:row.due_date?dayView(row.due_date):null,serviceMonth:row.service_month?String(dayView(row.service_month)).slice(0,7):null,payerName:snapshot.payer_name??snapshot.student_name??'',studentNames:snapshot.student_name?[snapshot.student_name]:[],revision:Number(row.revision),sourceRevision:Number(row.source_revision),payerId:row.payer_id??null,payableMinor:safeHistoryMinor(row.payable_minor??row.face_minor),recordedPaidMinor:safeHistoryMinor(row.recorded_paid_minor??row.declared_paid_minor),verifiedMinor:safeHistoryMinor(row.verified_minor??0),outstandingMinor:safeHistoryMinor(row.outstanding_minor??0),creditMinor:safeHistoryMinor(row.credit_minor??0),refundMinor:safeHistoryMinor(row.refund_minor??0)};
}
function stagedView(row:Record<string,any>) {
  return {id:row.id,origin:'imported',source:sourceView('imported',row.id,Number(row.revision)),status:row.status,invoiceNumber:row.invoice_number??null,amountMinor:safeHistoryMinor(row.amount_minor),currency:row.currency,invoiceDate:dayView(row.invoice_date),dueDate:null,serviceMonth:null,payerName:row.student_name,studentNames:[row.student_name],revision:Number(row.revision),sourceRevision:Number(row.revision),payerId:null};
}

@Injectable()
export class ReconciliationService implements OnModuleInit {
  constructor(@Inject(Database) private readonly db:Database,@Inject(EventBus) private readonly bus:EventBus) {}
  fetchService:typeof serviceFetch=serviceFetch;
  onModuleInit() {
    this.bus.subscribe('payments.payment-confirmed.v1',async(event,tx)=>{
      if(event.producer!=='payments')throw new Error('payment_producer_invalid');
      // Older deliveries remain represented by native allocations and recover via sync.
      const parsed=confirmedReceiptSchema.safeParse(Object.fromEntries(Object.entries(event.data).filter(([key])=>['paymentId','invoiceId','connectionId','provider','providerReference','amountMinor','currency','confirmedAt','simulated'].includes(key))));
      if(!parsed.success){if(event.data.connectionId!==undefined||event.data.providerReference!==undefined)throw new Error('confirmed_receipt_event_invalid');return;}
      await importConfirmedReceipts(tx,event.businessId,[parsed.data]);
    });
  }
  private async boundedJson(service:string,path:string,authorization:unknown,maxBytes:number,deadline=8000) {
    if(typeof authorization!=='string'||!/^Bearer \S+$/.test(authorization))throw new BadRequestException('Verified authorization required');
    const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const read=async()=>{
        const response=await this.fetchService(service,path,{headers:{authorization},signal:controller.signal});
        if(controller.signal.aborted){await response.body?.cancel();throw new ServiceUnavailableException('Verification unavailable');}
        if(!response.ok){await response.body?.cancel();if(response.status===403)throw new ForbiddenException('Identity or payment access denied');if(response.status===404)throw new BadRequestException('Select an accessible canonical identity');throw new ServiceUnavailableException('Verification unavailable');}
        if(!response.body)throw new ServiceUnavailableException('Verification unavailable');
        reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
        try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxBytes)throw new ServiceUnavailableException('Verification response exceeds limit');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        if(controller.signal.aborted)throw new ServiceUnavailableException('Verification unavailable');
        try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new ServiceUnavailableException('Verification response is invalid');}
      };
      return await Promise.race([read(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});reject(new ServiceUnavailableException('Verification deadline exceeded'));},deadline);})]);
    }catch(error){if(error instanceof BadRequestException||error instanceof ForbiddenException||error instanceof ServiceUnavailableException)throw error;throw new ServiceUnavailableException('Verification unavailable');}finally{if(timer)clearTimeout(timer);}
  }
  private async verifyIdentities(ctx:RequestContext,input:ReconciliationDecision,authorization:unknown) {
    const targets=[...input.studentIds.map(id=>({id,kind:'student' as const})),...(input.payerId?[{id:input.payerId,kind:'payer' as const}]:[])];
    if(!targets.length)return input;
    assertPermission(ctx,'clients.read');if(!ctx.entitlements.includes('clients'))throw new ForbiddenException('Clients is not enabled for this business');
    const deadline=Date.now()+8000,verified=new Map<string,string>();let cursor=0;
    await Promise.all(Array.from({length:Math.min(6,targets.length)},async()=>{
      while(cursor<targets.length){const target=targets[cursor++]!,remaining=deadline-Date.now();if(remaining<=0)throw new ServiceUnavailableException('Identity verification deadline exceeded');
        const response=identitySchema.safeParse(await this.boundedJson('clients',`/v1/clients/${target.id}/identity`,authorization,65536,remaining));
        if(!response.success||response.data.item.kind!==target.kind)throw new BadRequestException(`Choose an accessible canonical ${target.kind}`);
        verified.set(`${target.kind}:${target.id}`,response.data.item.id);
      }
    }));
    const studentIds=input.studentIds.map(id=>verified.get(`student:${id}`)!);
    if(new Set(studentIds).size!==studentIds.length)throw new BadRequestException('Two chosen students resolve to the same canonical student');
    return {...input,studentIds,...(input.payerId?{payerId:verified.get(`payer:${input.payerId}`)!}:{})};
  }
  async list(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(listSchema,query);
    return this.db.withTenant(ctx.businessId,async tx=>{
      if(await reconciliationNeedsProjection(tx,ctx.businessId))await ensureReconciliation(tx,ctx.businessId);
      const search=`%${input.search.replace(/[\\%_]/g,char=>`\\${char}`)}%`;
      if(input.state==='unresolved'){
        const where="h.business_id=$1 AND NOT EXISTS(SELECT 1 FROM reconciliation_source_aliases a WHERE a.business_id=h.business_id AND a.kind='imported' AND a.source_id=h.id) AND (h.student_name ILIKE $2 OR COALESCE(h.invoice_number,'') ILIKE $2)";
        const total=(await tx.query(`SELECT count(*) total FROM billing_invoice_history h WHERE ${where}`,[ctx.businessId,search])).rows[0].total;
        const rows=await tx.query(`SELECT h.* FROM billing_invoice_history h WHERE ${where} ORDER BY h.invoice_date DESC,h.id LIMIT $3 OFFSET $4`,[ctx.businessId,search,input.limit,input.offset]);
        return {items:rows.rows.map(stagedView),total:safeHistoryMinor(total),limit:input.limit,offset:input.offset};
      }
      const where="business_id=$1 AND (COALESCE(source_snapshot->>'student_name',source_snapshot->>'payer_name','') ILIKE $2 OR COALESCE(source_snapshot->>'invoice_number','') ILIKE $2)";
      const total=(await tx.query(`SELECT count(*) total FROM reconciliation_invoices WHERE ${where}`,[ctx.businessId,search])).rows[0].total;
      const rows=await tx.query(`${balanceSelection} WHERE ${where} ORDER BY i.invoice_date DESC,i.id LIMIT $3 OFFSET $4`,[ctx.businessId,search,input.limit,input.offset]);
      return {items:rows.rows.map(invoiceView),total:safeHistoryMinor(total),limit:input.limit,offset:input.offset};
    });
  }
  private async receiptRows(tx:PoolClient,businessId:string,curr:string|undefined,limit:number,offset:number,invoiceId?:string) {
    const rows=await tx.query(`SELECT r.*,COALESCE(a.used,0) allocated_minor,COALESCE(a.for_invoice,0) invoice_allocated_minor,COALESCE(f.refunded,0) refunded_minor,COALESCE(a.items,'[]'::json) allocations FROM reconciliation_receipts r LEFT JOIN LATERAL(SELECT sum(amount_minor) used,sum(amount_minor) FILTER(WHERE invoice_id=$5::uuid) for_invoice,(SELECT json_agg(json_build_object('invoiceId',bounded.invoice_id,'amountMinor',bounded.amount_minor)) FROM (SELECT invoice_id,amount_minor FROM reconciliation_allocations bounded WHERE bounded.business_id=r.business_id AND bounded.receipt_id=r.id ORDER BY bounded.created_at,bounded.id LIMIT 200) bounded) items FROM reconciliation_allocations a WHERE a.business_id=r.business_id AND a.receipt_id=r.id) a ON true LEFT JOIN LATERAL(SELECT sum(amount_minor) refunded FROM reconciliation_adjustments f WHERE f.business_id=r.business_id AND f.receipt_id=r.id AND f.kind='refund' AND ($5::uuid IS NULL OR f.invoice_id=$5)) f ON true WHERE r.business_id=$1 AND ($2::text IS NULL OR r.currency=$2) AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM reconciliation_allocations linked WHERE linked.business_id=r.business_id AND linked.receipt_id=r.id AND linked.invoice_id=$5)) ORDER BY r.paid_at DESC,r.id LIMIT $3 OFFSET $4`,[businessId,curr??null,limit,offset,invoiceId??null]);
    return rows.rows.map(row=>({id:row.id,revision:Number(row.revision),amountMinor:safeHistoryMinor(row.amount_minor),availableMinor:safeHistoryMinor((BigInt(row.amount_minor)-BigInt(row.allocated_minor)).toString()),allocatedMinor:safeHistoryMinor(invoiceId?row.invoice_allocated_minor:row.allocated_minor),refundedMinor:safeHistoryMinor(row.refunded_minor),currency:row.currency,date:dayView(row.paid_at),provider:row.provider,category:row.evidence,evidence:row.evidence,allocationLimit:200,allocations:row.allocations.map((allocation:any)=>({...allocation,amountMinor:safeHistoryMinor(allocation.amountMinor)}))}));
  }
  async detail(ctx:RequestContext,id:string) {
    assertHistoryAccess(ctx);parseBody(z.uuid(),id);
    return this.db.withTenant(ctx.businessId,async tx=>{
      if(await reconciliationNeedsProjection(tx,ctx.businessId))await ensureReconciliation(tx,ctx.businessId);
      const canonical=(await tx.query(`${balanceSelection} WHERE i.business_id=$1 AND (i.id=$2 OR EXISTS(SELECT 1 FROM reconciliation_source_aliases a WHERE a.business_id=i.business_id AND a.invoice_id=i.id AND a.source_id=$2)) LIMIT 1`,[ctx.businessId,id])).rows[0];
      const staged=!canonical?(await tx.query('SELECT * FROM billing_invoice_history WHERE business_id=$1 AND id=$2',[ctx.businessId,id])).rows[0]:undefined;
      if(!canonical&&!staged)throw new NotFoundException('reconciliation_invoice_not_found');
      const invoice=canonical?invoiceView(canonical):stagedView(staged),invoiceId=canonical?.id??null;
      const source=invoice.source;
      const aliases=invoiceId?(await tx.query('SELECT kind,source_id,source_revision FROM reconciliation_source_aliases WHERE business_id=$1 AND invoice_id=$2 ORDER BY kind,source_id LIMIT 200',[ctx.businessId,invoiceId])).rows.map(row=>sourceView(row.kind,row.source_id,Number(row.source_revision))):[];
      const students=invoiceId?(await tx.query('SELECT billing_student_root(student_id) id FROM reconciliation_beneficiaries WHERE business_id=$1 AND invoice_id=$2 ORDER BY student_id LIMIT 200',[ctx.businessId,invoiceId])).rows.map(row=>({id:row.id,name:null})):[];
      const work=(await tx.query(`SELECT w.*,COALESCE(c.covered,0) covered_minor,COALESCE(c.linked,0) linked_minor FROM billing_work_log w LEFT JOIN LATERAL(SELECT sum(amount_minor) covered,sum(amount_minor) FILTER(WHERE invoice_id=$3::uuid) linked FROM reconciliation_work_coverage c WHERE c.business_id=w.business_id AND c.work_id=w.id) c ON true WHERE w.business_id=$1 AND w.currency=$2 ORDER BY (COALESCE(c.linked,0)>0) DESC,(lower(w.student_name)=lower($4)) DESC,w.work_date DESC,w.id LIMIT 200`,[ctx.businessId,invoice.currency,invoiceId,invoice.payerName])).rows.map(row=>({id:row.id,revision:Number(row.revision),date:dayView(row.work_date),studentName:row.student_name,service:row.service_type,amountMinor:safeHistoryMinor(row.amount_minor),currency:row.currency,coveredMinor:safeHistoryMinor(row.covered_minor),linkedMinor:safeHistoryMinor(row.linked_minor)}));
      const suggestions=(await tx.query(`${balanceSelection} WHERE i.business_id=$1 AND i.currency=$2 AND ($3::uuid IS NULL OR i.id<>$3) ORDER BY (i.face_minor=$4) DESC,(lower(COALESCE(source_snapshot->>'student_name',source_snapshot->>'payer_name',''))=lower($5)) DESC,invoice_date DESC,id LIMIT 50`,[ctx.businessId,invoice.currency,invoiceId,invoice.amountMinor,invoice.payerName])).rows.map(invoiceView);
      return {invoice,source,aliases,students,payers:canonical?.payer_id?[{id:canonical.payer_id,name:null}]:[],work,suggestions:{invoices:suggestions,students:[],payers:[]},receipts:invoiceId?await this.receiptRows(tx,ctx.businessId,invoice.currency,200,0,invoiceId):[],revision:invoice.revision,sourceRevision:source.revision,workLimit:200,receiptLimit:200,aliasLimit:200,studentLimit:200};
    });
  }
  async preview(ctx:RequestContext,body:unknown,authorization:unknown) {
    assertHistoryAccess(ctx,true);const input=await this.verifyIdentities(ctx,parseBody(reconciliationDecisionSchema,body),authorization);
    return this.db.withTenant(ctx.businessId,tx=>previewDecision(tx,ctx,input));
  }
  async publish(ctx:RequestContext,body:unknown,key:unknown,authorization:unknown) {
    assertHistoryAccess(ctx,true);const input=await this.verifyIdentities(ctx,parseBody(reconciliationDecisionSchema,body),authorization);
    if(typeof key!=='string')throw new BadRequestException('valid_idempotency_key_required');
    return this.db.withTenant(ctx.businessId,tx=>publishDecision(tx,ctx,input,{idempotencyKey:key}));
  }
  async receipts(ctx:RequestContext,query:unknown) {
    assertHistoryAccess(ctx);const input=parseBody(receiptsQuery,query);
    return this.db.withTenant(ctx.businessId,async tx=>{if(await reconciliationNeedsProjection(tx,ctx.businessId))await ensureReconciliation(tx,ctx.businessId);const total=(await tx.query('SELECT count(*) total FROM reconciliation_receipts WHERE business_id=$1 AND ($2::text IS NULL OR currency=$2)',[ctx.businessId,input.currency??null])).rows[0].total;return {items:await this.receiptRows(tx,ctx.businessId,input.currency,input.limit,input.offset),total:safeHistoryMinor(total),limit:input.limit,offset:input.offset};});
  }
  async sync(ctx:RequestContext,body:unknown,authorization:unknown) {
    assertHistoryAccess(ctx,true);assertPermission(ctx,'payments.read');if(!ctx.entitlements.includes('payments'))throw new ForbiddenException('Payments is not enabled for this business');
    const input=parseBody(syncSchema,body),pageResult=confirmedReceiptsResponseSchema.safeParse(await this.boundedJson('payments',`/v1/reconciliation/transactions?limit=${input.limit}&offset=${input.offset}`,authorization,262144));
    if(!pageResult.success)throw new ServiceUnavailableException('Payment recovery response is invalid');
    const result=await this.db.withTenant(ctx.businessId,async tx=>{const recovered=await importConfirmedReceipts(tx,ctx.businessId,pageResult.data.items);if(recovered.imported||recovered.enriched){await tx.query('INSERT INTO reconciliation_audit(business_id,id,operation,actor_id,request_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[ctx.businessId,randomUUID(),'receipt-sync',ctx.sub,ctx.requestId,JSON.stringify({...recovered,offset:input.offset,limit:input.limit})]);}return {imported:pageResult.data.items.length,recovered,total:pageResult.data.total,limit:pageResult.data.limit,offset:pageResult.data.offset,nextOffset:pageResult.data.offset+pageResult.data.items.length,hasMore:pageResult.data.offset+pageResult.data.items.length<pageResult.data.total};});return result;
  }
  async historicalReceipt(ctx:RequestContext,body:unknown,key:unknown) {assertHistoryAccess(ctx,true);const {confirmed,...input}=parseBody(receiptSchema,body);if(typeof key!=='string')throw new BadRequestException('valid_idempotency_key_required');return this.db.withTenant(ctx.businessId,tx=>recordHistoricalReceipt(tx,ctx,{...input,idempotencyKey:key}));}
  async allocate(ctx:RequestContext,body:unknown,key:unknown) {assertHistoryAccess(ctx,true);const {confirmed,...input}=parseBody(allocationSchema,body);if(typeof key!=='string')throw new BadRequestException('valid_idempotency_key_required');return this.db.withTenant(ctx.businessId,tx=>allocateReceipt(tx,ctx,{...input,idempotencyKey:key}));}
  async adjust(ctx:RequestContext,body:unknown,key:unknown) {assertHistoryAccess(ctx,true);const {confirmed,...input}=parseBody(adjustmentSchema,body);if(typeof key!=='string')throw new BadRequestException('valid_idempotency_key_required');return this.db.withTenant(ctx.businessId,tx=>adjustInvoice(tx,ctx,{...input,idempotencyKey:key}));}
}

@Controller('v1/reconciliation')
@Roles('owner','admin','tutor')
@Permissions('billing.read','reporting.financial')
export class ReconciliationController {
  constructor(@Inject(ReconciliationService) private readonly service:ReconciliationService) {}
  @Get('invoices') list(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.list(ctx,query);}
  @Get('invoices/:id') async detail(@CurrentContext() ctx:RequestContext,@Param('id') id:string){return {item:await this.service.detail(ctx,id)};}
  @Post('preview') @Permissions('billing.read','reporting.financial','billing.write') async preview(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('authorization') auth:unknown){return {item:await this.service.preview(ctx,body,auth)};}
  @Post('publish') @Permissions('billing.read','reporting.financial','billing.write') async publish(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:unknown,@Headers('authorization') auth:unknown){return {item:await this.service.publish(ctx,body,key,auth)};}
  @Get('receipts') receipts(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.receipts(ctx,query);}
  @Post('receipts/sync') @Permissions('billing.read','reporting.financial','billing.write','payments.read') async sync(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('authorization') auth:unknown){return {item:await this.service.sync(ctx,body,auth)};}
  @Post('receipts') @Permissions('billing.read','reporting.financial','billing.write') async historicalReceipt(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:unknown){return {item:await this.service.historicalReceipt(ctx,body,key)};}
  @Post('allocations') @Permissions('billing.read','reporting.financial','billing.write') async allocate(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:unknown){return {item:await this.service.allocate(ctx,body,key)};}
  @Post('adjustments') @Permissions('billing.read','reporting.financial','billing.write') async adjust(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:unknown){return {item:await this.service.adjust(ctx,body,key)};}
}
