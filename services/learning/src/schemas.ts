import { z } from 'zod';
export const uuid = z.string().uuid();
export const httpsUrl = z.string().url().max(2000).refine(v => new URL(v).protocol === 'https:', 'Use an HTTPS URL');
export const assignmentSchema = z.object({
 clientId:uuid,title:z.string().trim().min(1).max(200),description:z.string().max(5000).default(''),
 dueAt:z.string().datetime().nullable().optional(),resourceIds:z.array(uuid).max(50).default([]),
}).strict().refine(v => new Set(v.resourceIds).size === v.resourceIds.length,{message:'Duplicate resource reference',path:['resourceIds']});
export const resourceSchema = z.discriminatedUnion('kind',[
 z.object({clientId:uuid,title:z.string().trim().min(1).max(200),kind:z.literal('link'),url:httpsUrl}).strict(),
 z.object({clientId:uuid,title:z.string().trim().min(1).max(200),kind:z.literal('file_metadata'),fileName:z.string().trim().min(1).max(255),mimeType:z.string().trim().min(1).max(100).optional(),sizeBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()}).strict(),
]);
export const submissionSchema = z.object({submissionText:z.string().trim().min(1).max(10000).optional(),submissionUrl:httpsUrl.optional()}).strict().refine(v=>Boolean(v.submissionText || v.submissionUrl),{message:'Provide submissionText or submissionUrl'});
export const reviewSchema = z.object({status:z.enum(['completed','needs_revision']),feedback:z.string().trim().max(5000).default('')}).strict();
export const listSchema = z.object({clientId:uuid.optional(),status:z.enum(['assigned','submitted','completed','needs_revision']).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).strict();
export const resourceListSchema = listSchema.omit({status:true});
