import {z} from 'zod';
import {isIP} from 'node:net';
export const idSchema=z.uuid();
export const revisionSchema=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const title=z.string().trim().min(1).max(200);
const description=z.string().max(10000);
export const positionSchema=z.number().finite().min(-1e9).max(1e9);
export const timeZoneSchema=z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Use an IANA time zone');
export function safeHttps(value:string) {
 try {const u=new URL(value),h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!isIP(h)&&h.includes('.')&&!['localhost','localhost.localdomain'].includes(h)&&!h.endsWith('.localhost')&&!h.endsWith('.local')&&!h.endsWith('.internal')&&!h.endsWith('.test');}catch{return false;}
}
export const linkSchema=z.string().max(2048).refine(safeHttps,'Use a public HTTPS link without credentials');
export const checklistSchema=z.array(z.object({id:z.uuid(),text:z.string().trim().min(1).max(500),done:z.boolean()}).strict()).max(100).refine(items=>new Set(items.map(i=>i.id)).size===items.length,'Checklist IDs must be unique');
export const referenceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('link'),label:title,url:linkSchema}).strict(),
 z.object({kind:z.literal('google_doc'),label:title,url:linkSchema.refine(value=>{const u=new URL(value);return u.hostname==='docs.google.com'&&/^\/document\/d\/[A-Za-z0-9_-]+(?:\/(?:edit|view|preview))?\/?$/.test(u.pathname);},'Select an HTTPS Google document')}).strict(),
 z.object({kind:z.literal('learning_resource'),label:title,resourceId:z.uuid()}).strict(),
]);
const deadlineShape={kind:z.enum(['official','personal']),dueAt:z.iso.datetime({offset:true}).nullable(),timeZone:timeZoneSchema,
 sourceUrls:z.array(linkSchema).max(10).default([]),cycle:z.number().int().min(2027).max(2200).nullable().default(null),
 round:z.string().max(100).nullable().default(null),applicability:z.string().max(2000).default('')};
// Clients can enter dates; they cannot assert that a source was independently verified.
export const deadlineInputSchema=z.object(deadlineShape).strict().refine(v=>v.kind!=='official'||v.sourceUrls.length>0,'An official date requires a source URL');
export const deadlineSchema=z.object({...deadlineShape,status:z.enum(['verified','requires_confirmation','user_set']),verifiedAt:z.iso.datetime().nullable()}).strict();
export const sharingSchema=z.enum(['private','student']);
export const boardCreateSchema=z.object({studentId:z.uuid(),name:title,description:description.default(''),sharing:sharingSchema.default('private')}).strict();
export const boardUpdateSchema=z.object({expectedRevision:revisionSchema,name:title.optional(),description:description.optional(),sharing:sharingSchema.optional()}).strict();
export const deleteSchema=z.object({expectedRevision:revisionSchema}).strict();
export const columnCreateSchema=z.object({expectedBoardRevision:revisionSchema,name:title,position:positionSchema}).strict();
export const columnUpdateSchema=z.object({expectedBoardRevision:revisionSchema,expectedRevision:revisionSchema,name:title.optional(),position:positionSchema.optional()}).strict();
export const columnDeleteSchema=z.object({expectedBoardRevision:revisionSchema,expectedRevision:revisionSchema,moveCardsToColumnId:z.uuid().optional()}).strict();
export const cardFields={title,description:description.default(''),checklist:checklistSchema.default([]),references:z.array(referenceSchema).max(30).default([]),deadline:deadlineInputSchema.nullable().default(null),learningAssignmentId:z.uuid().nullable().default(null)};
export const cardCreateSchema=z.object({...cardFields,expectedBoardRevision:revisionSchema,columnId:z.uuid(),position:positionSchema}).strict();
export const cardUpdateSchema=z.object({expectedRevision:revisionSchema,title:title.optional(),description:description.optional(),checklist:checklistSchema.optional(),references:z.array(referenceSchema).max(30).optional(),deadline:deadlineInputSchema.nullable().optional(),learningAssignmentId:z.uuid().nullable().optional()}).strict();
export const cardMoveSchema=z.object({expectedRevision:revisionSchema,expectedBoardRevision:revisionSchema,columnId:z.uuid(),position:positionSchema}).strict();
export const listSchema=z.object({studentId:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(100000).default(0)}).strict();
export const templateQuerySchema=z.object({cycle:z.coerce.number().int().min(2027).max(2200).default(2027)}).strict();
export const templateVersionQuery=z.object({version:z.coerce.number().int().positive().optional()}).strict();
export const templateKeySchema=z.string().regex(/^[a-z][a-z0-9-]{2,79}$/);
export const applicabilitySchema=z.object({cycle:z.number().int().min(2027).max(2200),country:z.string().regex(/^[A-Z]{2}$/),applicantCountry:z.string().regex(/^[A-Z]{2}$/).optional(),applicantCategory:z.string().min(1).max(100),program:z.string().min(1).max(100),round:z.string().min(1).max(100)}).strict();
export const instantiateSchema=z.object({studentId:z.uuid(),version:z.number().int().positive(),name:title.optional(),idempotencyKey:z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/),applicabilityConfirmed:z.literal(true),applicability:applicabilitySchema,sharing:sharingSchema.default('private')}).strict();
export const customTemplateSchema=z.object({key:templateKeySchema,name:title,cycle:z.number().int().min(2027).max(2200),country:z.string().regex(/^[A-Z]{2}$/),applicantCountries:z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).default([]),applicantCategory:z.string().min(1).max(100),program:z.string().min(1).max(100),round:z.string().min(1).max(100),applicability:z.string().max(2000),sourceUrls:z.array(linkSchema).max(10).default([]),columns:z.array(title).min(1).max(30),cards:z.array(z.object({...cardFields,key:z.string().regex(/^[a-z0-9-]{1,80}$/),columnIndex:z.number().int().nonnegative().max(29)}).strict()).max(200)}).strict().refine(v=>v.cards.every(c=>c.columnIndex<v.columns.length)&&new Set(v.cards.map(c=>c.key)).size===v.cards.length,'Use existing columns and unique card keys');
export const templateReviewSchema=z.object({version:z.coerce.number().int().positive()}).strict();
export const templateApplySchema=z.object({version:z.number().int().positive(),expectedRevision:revisionSchema,cardIds:z.array(z.uuid()).max(200),
 addedCardKeys:z.array(z.string().regex(/^[a-z0-9-]{1,80}$/)).max(200).refine(keys=>new Set(keys).size===keys.length,'Template task keys must be unique').optional()}).strict();
export type Deadline=z.infer<typeof deadlineSchema>;
export function enteredDeadline(input:z.infer<typeof deadlineInputSchema>|null):Deadline|null {
 return input?{...input,status:input.kind==='personal'&&input.dueAt?'user_set':'requires_confirmation',verifiedAt:null}:null;
}
