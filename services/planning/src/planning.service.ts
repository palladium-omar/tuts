import {BadRequestException,ConflictException,ForbiddenException,Inject,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {Database,assertStudentAccess,emitEvent,serviceFetch} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import type {PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import * as s from './schemas.js';
import {builtInTemplates,cycleForSystemKey,templatesForCycle,type TemplateDefinition} from './templates.js';
type Row=Record<string,any>;
const scoped=(ctx:RequestContext)=>ctx.accessScope==='students'||['student','parent'].includes(ctx.role);
const administrator=(ctx:RequestContext)=>!scoped(ctx)&&['owner','admin'].includes(ctx.role);
const iso=(v:any)=>v instanceof Date?v.toISOString():v;
export function boardItem(row:Row) {return {id:row.id,studentId:row.student_id,name:row.name,description:row.description,sharing:row.sharing,createdBy:row.created_by,revision:Number(row.revision),templateKey:row.template_key,templateVersion:row.template_version,applicability:row.applicability,archivedAt:iso(row.archived_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
export function columnItem(row:Row) {return {id:row.id,boardId:row.board_id,name:row.name,position:row.position,revision:Number(row.revision),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
export function cardItem(row:Row) {return {id:row.id,boardId:row.board_id,columnId:row.column_id,title:row.title,description:row.description,position:row.position,checklist:row.checklist,references:row.resource_references,deadline:row.deadline,deadlineEdited:row.deadline_edited,learningAssignmentId:row.learning_assignment_id,templateCardKey:row.template_card_key,createdBy:row.created_by,revision:Number(row.revision),archivedAt:iso(row.archived_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
export async function boardEvent(tx:PoolClient,ctx:Pick<RequestContext,'businessId'|'requestId'>,row:Row) {
 await emitEvent(tx,{type:'planning.board-updated.v1',producer:'planning',businessId:ctx.businessId,correlationId:ctx.requestId,data:{boardId:row.id,studentId:row.student_id,revision:Number(row.revision),sharing:row.sharing,archived:Boolean(row.archived_at),updatedAt:iso(row.updated_at)}});
}
async function cardEvent(tx:PoolClient,ctx:RequestContext,board:Row,row:Row) {
 await emitEvent(tx,{type:'planning.card-updated.v1',producer:'planning',businessId:ctx.businessId,correlationId:ctx.requestId,data:{cardId:row.id,boardId:board.id,studentId:board.student_id,revision:Number(row.revision),columnId:row.column_id,archived:Boolean(row.archived_at)||Boolean(board.archived_at),sharing:board.sharing,learningAssignmentId:row.learning_assignment_id,updatedAt:iso(row.updated_at)}});
}
@Injectable()
export class PlanningService {
 constructor(@Inject(Database) private readonly db:Database) {}
 private async canonical(tx:PoolClient,id:string):Promise<string> {return (await tx.query<{id:string}>('SELECT planning_canonical_student($1::uuid) id',[id])).rows[0]!.id;}
 private expect(actual:any,expected:number,label='Record') {if(Number(actual)!==expected)throw new ConflictException(`${label} changed; refresh and retry`);}
 private manager(ctx:RequestContext,board:Row) {if(board.created_by!==ctx.sub&&!administrator(ctx))throw new ForbiddenException('Only the board creator or a business administrator can change its structure or sharing');}
 private async board(tx:PoolClient,ctx:RequestContext,id:string,lock=false):Promise<Row> {
  const row=(await tx.query(`SELECT * FROM planning_boards WHERE id=$1 AND archived_at IS NULL${lock?' FOR UPDATE':''}`,[id])).rows[0];
  if(!row)throw new NotFoundException('Board not found');
  const student=await this.canonical(tx,row.student_id);assertStudentAccess(ctx,student);
  if(row.sharing==='private'&&row.created_by!==ctx.sub&&!administrator(ctx))throw new NotFoundException('Board not found');
  return {...row,student_id:student};
 }
 private async bump(tx:PoolClient,ctx:RequestContext,board:Row) {
  const row=(await tx.query('UPDATE planning_boards SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[board.id])).rows[0];
  const canonical={...row,student_id:board.student_id};await boardEvent(tx,ctx,canonical);return canonical;
 }
 private async column(tx:PoolClient,boardId:string,columnId:string) {
  const row=(await tx.query('SELECT * FROM planning_columns WHERE id=$1 AND board_id=$2',[columnId,boardId])).rows[0];
  if(!row)throw new NotFoundException('Column not found');return row;
 }
 private async student(ctx:RequestContext,id:string,authorization:string) {
  assertStudentAccess(ctx,id);
  if(!ctx.entitlements.includes('clients'))throw new ForbiddenException('Clients is required to create a student board');
  try {
   const response=await serviceFetch('clients',`/v1/portal/students/${id}`,{headers:{authorization},signal:AbortSignal.timeout(5000)});
   if(response.status===404)throw new NotFoundException('Student not found');
   if(response.status===403)throw new ForbiddenException('Student access is not granted');
   if(!response.ok)throw new Error('Student source unavailable');
   const body=z.object({item:z.object({id:z.uuid()})}).parse(await response.json());assertStudentAccess(ctx,body.item.id);return body.item.id;
  }catch(error){if(error instanceof NotFoundException||error instanceof ForbiddenException)throw error;throw new ServiceUnavailableException('Student validation is unavailable');}
 }
 private async seed(tx:PoolClient,ctx:RequestContext,cycle?:number) {
  const templates=cycle&&cycle>2031?[...builtInTemplates,...templatesForCycle(cycle)]:builtInTemplates;
  // One tenant-scoped insert per request, regardless of the number of releases.
  // Existing versions remain immutable and previously-created boards untouched.
  await tx.query(`INSERT INTO planning_templates(business_id,template_key,version,name,definition,system)
   SELECT $1,seed.key,seed.version,seed.name,seed.definition::jsonb,true
   FROM unnest($2::text[],$3::integer[],$4::text[],$5::text[]) AS seed(key,version,name,definition)
   ON CONFLICT DO NOTHING`,[ctx.businessId,templates.map(t=>t.key),templates.map(t=>t.version),templates.map(t=>t.name),templates.map(t=>JSON.stringify(t))]);
 }
 private async template(tx:PoolClient,key:string,version?:number):Promise<{item:Row;definition:TemplateDefinition}> {
  const row=(await tx.query(`SELECT * FROM planning_templates WHERE template_key=$1${version?' AND version=$2':''} ORDER BY version DESC LIMIT 1`,version?[key,version]:[key])).rows[0];
  if(!row)throw new NotFoundException('Template version not found');return {item:row,definition:row.definition};
 }
 private templateItem(row:Row) {return {key:row.template_key,version:row.version,name:row.name,system:row.system,definition:row.definition,createdAt:iso(row.created_at)};}
 async templates(ctx:RequestContext,query:z.infer<typeof s.templateQuerySchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{await this.seed(tx,ctx,query.cycle);const rows=(await tx.query(`SELECT DISTINCT ON(template_key) * FROM planning_templates WHERE (definition->>'cycle')::integer=$1 ORDER BY template_key,version DESC LIMIT 200`,[query.cycle])).rows;return {items:rows.map(row=>this.templateItem(row)),cycle:query.cycle};});
 }
 async templateDetail(ctx:RequestContext,key:string,version?:number) {
  return this.db.withTenant(ctx.businessId,async tx=>{await this.seed(tx,ctx,cycleForSystemKey(key));return {item:this.templateItem((await this.template(tx,key,version)).item)};});
 }
 async createTemplate(ctx:RequestContext,input:z.infer<typeof s.customTemplateSchema>) {
  if(!input.key.startsWith('custom-'))throw new BadRequestException('User template keys must begin with custom-');
  return this.db.withTenant(ctx.businessId,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.businessId}:template:${input.key}`]);
   const version=Number((await tx.query('SELECT coalesce(max(version),0)+1 version FROM planning_templates WHERE template_key=$1',[input.key])).rows[0].version);
   const definition:TemplateDefinition={...input,version,verifiedAt:null,cards:input.cards.map(card=>({...card,deadline:s.enteredDeadline(card.deadline)}))};
   const row=(await tx.query(`INSERT INTO planning_templates(business_id,template_key,version,name,definition,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[ctx.businessId,input.key,version,input.name,JSON.stringify(definition),ctx.sub])).rows[0];
   await emitEvent(tx,{type:'planning.template-published.v1',producer:'planning',businessId:ctx.businessId,correlationId:ctx.requestId,data:{templateKey:input.key,version}});return {item:this.templateItem(row)};
  });
 }
 async boards(ctx:RequestContext,query:z.infer<typeof s.listSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{
   let student=query.studentId;if(student){student=await this.canonical(tx,student);assertStudentAccess(ctx,student);}
   const args=[student??null,scoped(ctx),ctx.studentIds??[],ctx.sub,administrator(ctx)];
   const where=`archived_at IS NULL AND ($1::uuid IS NULL OR planning_canonical_student(student_id)=$1)
    AND (NOT $2::boolean OR planning_canonical_student(student_id)=ANY($3::uuid[])) AND (sharing='student' OR created_by=$4 OR $5::boolean)`;
   const total=Number((await tx.query(`SELECT count(*) total FROM planning_boards WHERE ${where}`,args)).rows[0].total);
   const rows=(await tx.query(`SELECT *,planning_canonical_student(student_id) canonical_id FROM planning_boards WHERE ${where} ORDER BY updated_at DESC,id LIMIT $6 OFFSET $7`,[...args,query.limit,query.offset])).rows;
   return {items:rows.map(row=>boardItem({...row,student_id:row.canonical_id})),total,limit:query.limit,offset:query.offset};
  });
 }
 private async detail(tx:PoolClient,ctx:RequestContext,board:Row) {
  const columns=(await tx.query('SELECT * FROM planning_columns WHERE board_id=$1 ORDER BY position,id LIMIT 30',[board.id])).rows;
  const cards=(await tx.query('SELECT * FROM planning_cards WHERE board_id=$1 AND archived_at IS NULL ORDER BY column_id,position,id LIMIT 500',[board.id])).rows;
  return {item:boardItem(board),columns:columns.map(columnItem),cards:cards.map(cardItem),canManageStructure:board.created_by===ctx.sub||administrator(ctx)};
 }
 async boardDetail(ctx:RequestContext,id:string) {return this.db.withTenant(ctx.businessId,async tx=>this.detail(tx,ctx,await this.board(tx,ctx,id)));}
 async createBoard(ctx:RequestContext,input:z.infer<typeof s.boardCreateSchema>,authorization:string) {
  const student=await this.student(ctx,input.studentId,authorization);
  return this.db.withTenant(ctx.businessId,async tx=>{
   const canonical=await this.canonical(tx,student);assertStudentAccess(ctx,canonical);
   const row=(await tx.query(`INSERT INTO planning_boards(id,business_id,student_id,name,description,sharing,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[randomUUID(),ctx.businessId,canonical,input.name,input.description,input.sharing,ctx.sub])).rows[0];
   for(const [position,name] of ['To do','In progress','Done'].entries())await tx.query('INSERT INTO planning_columns(id,business_id,board_id,name,position) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.businessId,row.id,name,position]);
   await boardEvent(tx,ctx,row);return this.detail(tx,ctx,row);
  });
 }
 async updateBoard(ctx:RequestContext,id:string,input:z.infer<typeof s.boardUpdateSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const board=await this.board(tx,ctx,id,true);this.manager(ctx,board);this.expect(board.revision,input.expectedRevision,'Board');
   await tx.query('UPDATE planning_boards SET name=$2,description=$3,sharing=$4 WHERE id=$1',[id,input.name??board.name,input.description??board.description,input.sharing??board.sharing]);return {item:boardItem(await this.bump(tx,ctx,board))};});
 }
 async deleteBoard(ctx:RequestContext,id:string,revision:number) {
  return this.db.withTenant(ctx.businessId,async tx=>{const board=await this.board(tx,ctx,id,true);this.manager(ctx,board);this.expect(board.revision,revision,'Board');
   await tx.query('UPDATE planning_boards SET archived_at=now() WHERE id=$1',[id]);const changed=await this.bump(tx,ctx,board);
   const cards=(await tx.query('UPDATE planning_cards SET archived_at=now(),revision=revision+1,updated_at=now() WHERE board_id=$1 AND archived_at IS NULL RETURNING *',[id])).rows;
   for(const card of cards)await cardEvent(tx,ctx,changed,card);return {item:boardItem(changed)};});
 }
 async createColumn(ctx:RequestContext,id:string,input:z.infer<typeof s.columnCreateSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const board=await this.board(tx,ctx,id,true);this.manager(ctx,board);this.expect(board.revision,input.expectedBoardRevision,'Board');
   if(Number((await tx.query('SELECT count(*) total FROM planning_columns WHERE board_id=$1',[id])).rows[0].total)>=30)throw new ConflictException('A board supports up to 30 columns');
   const row=(await tx.query('INSERT INTO planning_columns(id,business_id,board_id,name,position) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),ctx.businessId,id,input.name,input.position])).rows[0];return {item:columnItem(row),board:boardItem(await this.bump(tx,ctx,board))};});
 }
 async updateColumn(ctx:RequestContext,id:string,columnId:string,input:z.infer<typeof s.columnUpdateSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const board=await this.board(tx,ctx,id,true);this.manager(ctx,board);this.expect(board.revision,input.expectedBoardRevision,'Board');const col=await this.column(tx,id,columnId);this.expect(col.revision,input.expectedRevision,'Column');
   const row=(await tx.query('UPDATE planning_columns SET name=$2,position=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[columnId,input.name??col.name,input.position??col.position])).rows[0];return {item:columnItem(row),board:boardItem(await this.bump(tx,ctx,board))};});
 }
 async deleteColumn(ctx:RequestContext,id:string,columnId:string,input:z.infer<typeof s.columnDeleteSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const board=await this.board(tx,ctx,id,true);this.manager(ctx,board);this.expect(board.revision,input.expectedBoardRevision,'Board');const col=await this.column(tx,id,columnId);this.expect(col.revision,input.expectedRevision,'Column');
   if(Number((await tx.query('SELECT count(*) total FROM planning_columns WHERE board_id=$1',[id])).rows[0].total)<=1)throw new ConflictException('Keep at least one board column');
   const cards=(await tx.query('SELECT * FROM planning_cards WHERE column_id=$1',[columnId])).rows;
   if(cards.length&&!input.moveCardsToColumnId)throw new ConflictException('Select a destination for this column’s cards');
   if(input.moveCardsToColumnId){if(input.moveCardsToColumnId===columnId)throw new BadRequestException('Choose another column');await this.column(tx,id,input.moveCardsToColumnId);}
   const moved=input.moveCardsToColumnId?(await tx.query('UPDATE planning_cards SET column_id=$2,revision=revision+1,updated_at=now() WHERE column_id=$1 RETURNING *',[columnId,input.moveCardsToColumnId])).rows:[];
   await tx.query('DELETE FROM planning_columns WHERE id=$1',[columnId]);const changed=await this.bump(tx,ctx,board);for(const card of moved)await cardEvent(tx,ctx,changed,card);return {deletedId:columnId,board:boardItem(changed),cards:moved.filter(row=>!row.archived_at).map(cardItem)};});
 }
 async cards(ctx:RequestContext,id:string,query:z.infer<typeof s.listSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const board=await this.board(tx,ctx,id);if(query.studentId&&await this.canonical(tx,query.studentId)!==board.student_id)throw new BadRequestException('Student does not match board');
   const total=Number((await tx.query('SELECT count(*) total FROM planning_cards WHERE board_id=$1 AND archived_at IS NULL',[id])).rows[0].total);
   const rows=(await tx.query('SELECT * FROM planning_cards WHERE board_id=$1 AND archived_at IS NULL ORDER BY column_id,position,id LIMIT $2 OFFSET $3',[id,query.limit,query.offset])).rows;return {items:rows.map(cardItem),boardRevision:Number(board.revision),total,limit:query.limit,offset:query.offset};});
 }
 private async insertCard(tx:PoolClient,ctx:RequestContext,board:Row,input:{columnId:string;position:number;title:string;description:string;checklist:unknown;references:unknown;deadline:unknown;learningAssignmentId:string|null;templateCardKey?:string}) {
  return (await tx.query(`INSERT INTO planning_cards(id,business_id,board_id,column_id,position,title,description,checklist,resource_references,deadline,learning_assignment_id,template_card_key,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[randomUUID(),ctx.businessId,board.id,input.columnId,input.position,input.title,input.description,JSON.stringify(input.checklist),JSON.stringify(input.references),JSON.stringify(input.deadline),input.learningAssignmentId,input.templateCardKey??null,ctx.sub])).rows[0];
 }
 async createCard(ctx:RequestContext,id:string,input:z.infer<typeof s.cardCreateSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const board=await this.board(tx,ctx,id,true);this.expect(board.revision,input.expectedBoardRevision,'Board');await this.column(tx,id,input.columnId);
   if(Number((await tx.query('SELECT count(*) total FROM planning_cards WHERE board_id=$1 AND archived_at IS NULL',[id])).rows[0].total)>=500)throw new ConflictException('A board supports up to 500 active cards');
   const row=await this.insertCard(tx,ctx,board,{...input,deadline:s.enteredDeadline(input.deadline)});const changed=await this.bump(tx,ctx,board);await cardEvent(tx,ctx,changed,row);return {item:cardItem(row),board:boardItem(changed)};});
 }
 private async card(tx:PoolClient,ctx:RequestContext,id:string) {
  const original=(await tx.query('SELECT board_id FROM planning_cards WHERE id=$1 AND archived_at IS NULL',[id])).rows[0];if(!original)throw new NotFoundException('Card not found');
  const board=await this.board(tx,ctx,original.board_id,true);
  const row=(await tx.query('SELECT * FROM planning_cards WHERE id=$1 AND archived_at IS NULL FOR UPDATE',[id])).rows[0];if(!row)throw new NotFoundException('Card not found');return {board,row};
 }
 async cardDetail(ctx:RequestContext,id:string) {return this.db.withTenant(ctx.businessId,async tx=>{const {board,row}=await this.card(tx,ctx,id);return {item:cardItem(row),board:boardItem(board)};});}
 async updateCard(ctx:RequestContext,id:string,input:z.infer<typeof s.cardUpdateSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const {board,row}=await this.card(tx,ctx,id);this.expect(row.revision,input.expectedRevision,'Card');
   const updated=(await tx.query(`UPDATE planning_cards SET title=$2,description=$3,checklist=$4,resource_references=$5,deadline=$6,learning_assignment_id=$7,
    deadline_edited=$8,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,input.title??row.title,input.description??row.description,JSON.stringify(input.checklist??row.checklist),JSON.stringify(input.references??row.resource_references),JSON.stringify(input.deadline===undefined?row.deadline:s.enteredDeadline(input.deadline)),input.learningAssignmentId===undefined?row.learning_assignment_id:input.learningAssignmentId,row.deadline_edited||input.deadline!==undefined])).rows[0];
   const changed=await this.bump(tx,ctx,board);await cardEvent(tx,ctx,changed,updated);return {item:cardItem(updated),board:boardItem(changed)};});
 }
 async moveCard(ctx:RequestContext,id:string,input:z.infer<typeof s.cardMoveSchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const {board,row}=await this.card(tx,ctx,id);this.expect(row.revision,input.expectedRevision,'Card');this.expect(board.revision,input.expectedBoardRevision,'Board');await this.column(tx,board.id,input.columnId);
   const changedCard=(await tx.query('UPDATE planning_cards SET column_id=$2,position=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[id,input.columnId,input.position])).rows[0];const changed=await this.bump(tx,ctx,board);await cardEvent(tx,ctx,changed,changedCard);return {item:cardItem(changedCard),board:boardItem(changed)};});
 }
 async deleteCard(ctx:RequestContext,id:string,revision:number) {
  return this.db.withTenant(ctx.businessId,async tx=>{const {board,row}=await this.card(tx,ctx,id);this.expect(row.revision,revision,'Card');const changedCard=(await tx.query('UPDATE planning_cards SET archived_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[id])).rows[0];const changed=await this.bump(tx,ctx,board);await cardEvent(tx,ctx,changed,changedCard);return {item:cardItem(changedCard),board:boardItem(changed)};});
 }
 async instantiate(ctx:RequestContext,key:string,input:z.infer<typeof s.instantiateSchema>,authorization:string) {
  const student=await this.student(ctx,input.studentId,authorization);
  const hash=createHash('sha256').update(JSON.stringify({key,...input})).digest('hex');
  return this.db.withTenant(ctx.businessId,async tx=>{await this.seed(tx,ctx,cycleForSystemKey(key));
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.businessId}:${ctx.sub}:instantiate:${input.idempotencyKey}`]);
   const saved=(await tx.query('SELECT * FROM planning_instantiations WHERE actor_id=$1 AND idempotency_key=$2',[ctx.sub,input.idempotencyKey])).rows[0];
   if(saved){if(saved.request_hash!==hash)throw new ConflictException('Idempotency key was used for different template choices');return {...await this.detail(tx,ctx,await this.board(tx,ctx,saved.board_id)),replayed:true};}
   const {definition:t}=await this.template(tx,key,input.version),a=input.applicability;
   if(a.cycle!==t.cycle||a.country!==t.country||a.applicantCategory!==t.applicantCategory||a.program!==t.program||a.round!==t.round||(t.applicantCountries.length&&!t.applicantCountries.includes(a.applicantCountry??'')))throw new BadRequestException('Confirm a country, applicant category, program and round that match this template');
   const canonical=await this.canonical(tx,student);assertStudentAccess(ctx,canonical);
   const board=(await tx.query(`INSERT INTO planning_boards(id,business_id,student_id,name,sharing,created_by,template_key,template_version,applicability)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),ctx.businessId,canonical,input.name??t.name,input.sharing,ctx.sub,key,input.version,JSON.stringify({...a,confirmed:true,confirmedBy:ctx.sub,confirmedAt:new Date().toISOString()})])).rows[0];
   const columnIds:string[]=[];for(const [position,name] of t.columns.entries()){const id=randomUUID();columnIds.push(id);await tx.query('INSERT INTO planning_columns(id,business_id,board_id,name,position) VALUES($1,$2,$3,$4,$5)',[id,ctx.businessId,board.id,name,position]);}
   for(const [position,card] of t.cards.entries()){const row=await this.insertCard(tx,ctx,board,{...card,position,columnId:columnIds[card.columnIndex]!,templateCardKey:card.key});await cardEvent(tx,ctx,board,row);}
   await tx.query('INSERT INTO planning_instantiations(business_id,actor_id,idempotency_key,request_hash,board_id) VALUES($1,$2,$3,$4,$5)',[ctx.businessId,ctx.sub,input.idempotencyKey,hash,board.id]);await boardEvent(tx,ctx,board);return {...await this.detail(tx,ctx,board),replayed:false};
  });
 }
 private async review(tx:PoolClient,ctx:RequestContext,id:string,version:number) {
  const board=await this.board(tx,ctx,id,true);this.manager(ctx,board);if(!board.template_key)throw new BadRequestException('Board was not created from a template');if(version<board.template_version)throw new ConflictException('Template review cannot roll back to an older version');
  const {definition}=await this.template(tx,board.template_key,version);if(definition.cycle!==board.applicability?.cycle||definition.country!==board.applicability?.country||definition.round!==board.applicability?.round||definition.program!==board.applicability?.program||definition.applicantCategory!==board.applicability?.applicantCategory||(definition.applicantCountries.length&&!definition.applicantCountries.includes(board.applicability?.applicantCountry)))throw new ConflictException('New template applicability requires a new board');
  const rows=(await tx.query('SELECT * FROM planning_cards WHERE board_id=$1 AND archived_at IS NULL',[id])).rows;
  const columns=(await tx.query('SELECT * FROM planning_columns WHERE board_id=$1 ORDER BY position,id LIMIT 30',[id])).rows;
  const suggestions=rows.filter(row=>row.template_card_key&&definition.cards.some(card=>card.key===row.template_card_key)).map(row=>({cardId:row.id,expectedRevision:Number(row.revision),templateCardKey:row.template_card_key,currentDeadline:row.deadline,proposedDeadline:definition.cards.find(card=>card.key===row.template_card_key)!.deadline,preserveUserEdit:Boolean(row.deadline_edited)}));
  const addedCards=definition.cards.filter(card=>!rows.some(row=>row.template_card_key===card.key)).map(card=>({...card,
   destinationColumnId:(columns.find(column=>column.name===definition.columns[card.columnIndex])??columns[card.columnIndex]??columns[0])?.id??null}));
  return {board,definition,suggestions,addedCards,rows};
 }
 async reviewTemplate(ctx:RequestContext,id:string,version:number) {return this.db.withTenant(ctx.businessId,async tx=>{const {board,definition,suggestions,addedCards}=await this.review(tx,ctx,id,version);return {board:boardItem(board),templateVersion:definition.version,suggestions,addedCards,automaticApply:false};});}
 async applyTemplate(ctx:RequestContext,id:string,input:z.infer<typeof s.templateApplySchema>) {
  return this.db.withTenant(ctx.businessId,async tx=>{const {board,definition,suggestions,addedCards,rows}=await this.review(tx,ctx,id,input.version);this.expect(board.revision,input.expectedRevision,'Board');
   const selected=new Set(input.cardIds);if(selected.size!==input.cardIds.length||input.cardIds.some(id=>!suggestions.some(row=>row.cardId===id)))throw new BadRequestException('Select existing template cards');
   const selectedKeys=input.addedCardKeys??[],addKeys=new Set(selectedKeys);
   if(addKeys.size!==selectedKeys.length||selectedKeys.some(key=>!definition.cards.some(card=>card.key===key)))throw new BadRequestException('Select existing template task keys');
   const additions=addedCards.filter(card=>addKeys.has(card.key));
   if(rows.length+additions.length>500)throw new ConflictException('A board supports up to 500 active cards');
   if(additions.some(card=>!card.destinationColumnId))throw new ConflictException('Add a board column before adding template tasks');
   const updated:Row[]=[];for(const suggestion of suggestions.filter(row=>selected.has(row.cardId))){if(suggestion.preserveUserEdit)continue;const row=(await tx.query('UPDATE planning_cards SET deadline=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[suggestion.cardId,JSON.stringify(suggestion.proposedDeadline)])).rows[0];updated.push(row);}
   const added:Row[]=[];
   for(const card of additions){
    const position=Math.min(1e9,Math.max(-1,...[...rows,...added].filter(row=>row.column_id===card.destinationColumnId).map(row=>Number(row.position)))+1);
    added.push(await this.insertCard(tx,ctx,board,{...card,columnId:card.destinationColumnId,position,templateCardKey:card.key}));
   }
   // Date updates are explicit; titles, checklists, resources, custom cards and
   // user-edited dates are never replaced. Selected additions append under the
   // parent lock; a fresh-revision retry skips keys already present on the board.
   await tx.query('UPDATE planning_boards SET template_version=$2 WHERE id=$1',[id,definition.version]);const changed=await this.bump(tx,ctx,board);for(const card of [...updated,...added])await cardEvent(tx,ctx,changed,card);return {board:boardItem(changed),cards:[...updated,...added].map(cardItem),addedCards:added.map(cardItem),alreadyPresentCardKeys:selectedKeys.filter(key=>rows.some(row=>row.template_card_key===key)),preservedCardIds:suggestions.filter(row=>selected.has(row.cardId)&&row.preserveUserEdit).map(row=>row.cardId)};
  });
 }
}
