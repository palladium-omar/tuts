import { z } from 'zod';
export const portalBusinessSchema = z.object({ businessId: z.uuid() }).strict();
export const portalListSchema = z.object({ businessId: z.uuid(), studentId: z.uuid().optional() }).strict();
export const invitationSchema = portalBusinessSchema.extend({
  studentId: z.uuid(), contactId: z.uuid(), emailAddressId: z.uuid(),
  relationship: z.enum(['student', 'guardian']),
});
export const portalAcceptSchema = portalBusinessSchema.extend({
  token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
});
export const portalIdSchema = z.uuid();
export const portalStudentResponseSchema = z.object({ item: z.object({
  id: z.uuid(), displayName: z.string(), portalProtected: z.boolean(),
  contacts: z.array(z.object({
    id: z.uuid(), displayName: z.string(), relationship: z.string(),
    emails: z.array(z.object({id: z.uuid(), value: z.email().max(254)})),
  })),
}) });
