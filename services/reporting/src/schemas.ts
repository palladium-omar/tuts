import { z } from 'zod';
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(v => Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 2200);
export const timeZoneSchema = z.string().max(100).refine(v => {
    try {
        new Intl.DateTimeFormat('en', {
            timeZone: v
        });
        return true;
    }
    catch {
        return false;
    }
}, 'Use a valid IANA time zone');
export const periodShape = {
    month: monthSchema, timeZone: timeZoneSchema
};
export const periodSchema = z.object(periodShape).strict();
export const summaryQuery = z.object({
    ...periodShape, includeFinancial: z.enum(['true', 'false']).optional()
}).strict();
export const summaryBatch = z.object({
    ...periodShape, studentIds: z.array(z.uuid()).min(1).max(100), includeFinancial: z.boolean().default(false)
}).strict();
export const reconcileSchema = z.object({
    ...periodShape, includeFinancial: z.boolean().default(false)
}).strict();
export const activityQuery = z.object({
    ...periodShape, limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0)
}).strict();
export const activityBody = z.object({
    studentId: z.uuid(), sessionId: z.uuid(), sequence: z.number().int().min(1).max(2147483647), activeSeconds: z.number().int().min(0).max(30)
}).strict();
export const financialTotalSchema = z.object({
    currency: z.string().regex(/^[A-Z]{3}$/), billedMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), collectedMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), simulatedMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), outstandingMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
});
export type Period = z.infer<typeof periodSchema>;
