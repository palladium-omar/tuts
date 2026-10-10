import { z } from "zod";
export const uuid = z.string().uuid();
export const httpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((v) => { const url = new URL(v); return url.protocol === "https:" && !url.username && !url.password; }, "Use an HTTPS URL without credentials");
export const googleDocUrl=httpsUrl.refine(value=>{const url=new URL(value);return url.hostname==='docs.google.com'&&!url.port&&!url.username&&!url.password&&/^\/document\/d\/[A-Za-z0-9_-]+(?:\/|$)/.test(url.pathname);},'Use a selected docs.google.com document link');
export const assignmentSchema = z
  .object({
    clientId: uuid,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(""),
    dueAt: z.string().datetime().nullable().optional(),
    resourceIds: z.array(uuid).max(50).default([]),
  })
  .strict()
  .refine((v) => new Set(v.resourceIds).size === v.resourceIds.length, {
    message: "Duplicate resource reference",
    path: ["resourceIds"],
  });
export const resourceSchema = z.discriminatedUnion("kind", [
  z.object({clientId:uuid,title:z.string().trim().min(1).max(200),kind:z.literal("google_doc"),url:googleDocUrl}).strict(),
  z
    .object({
      clientId: uuid,
      title: z.string().trim().min(1).max(200),
      kind: z.literal("link"),
      url: httpsUrl,
    })
    .strict(),
  z
    .object({
      clientId: uuid,
      title: z.string().trim().min(1).max(200),
      kind: z.literal("file_metadata"),
      fileName: z.string().trim().min(1).max(255),
      mimeType: z.string().trim().min(1).max(100).optional(),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .strict(),
]);
export const submissionSchema = z
  .object({
    submissionText: z.string().trim().min(1).max(10000).optional(),
    submissionUrl: httpsUrl.optional(),
    submissionResourceIds: z.array(uuid).max(20).default([]),
    expectedRevision:z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.submissionText || v.submissionUrl || v.submissionResourceIds.length), {
    message: "Provide submissionText or submissionUrl",
  });
export const reviewSchema = z
  .object({
    status: z.enum(["completed", "needs_revision"]),
    expectedRevision:z.number().int().positive().optional(),
    feedback: z.string().trim().max(5000).default(""),
  })
  .strict();
export const listSchema = z
  .object({
    clientId: uuid.optional(),
    status: z
      .enum(["assigned", "submitted", "completed", "needs_revision"])
      .optional(),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export const resourceListSchema = listSchema.omit({ status: true }).extend({
  kind: z.enum(['google_doc', 'link', 'file_metadata']).optional(),
});

export const uploadSchema = z
  .object({ clientId: uuid, title: z.string().trim().min(1).max(200) })
  .strict();

export const submissionUploadSchema=z.object({title:z.string().trim().min(1).max(200)}).strict();
