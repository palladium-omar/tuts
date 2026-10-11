import { z } from 'zod';

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const confirmedReceiptSchema = z.object({
  paymentId: z.uuid(), invoiceId: z.uuid(), connectionId: z.uuid(),
  provider: z.string().min(1).max(40), providerReference: z.string().min(1).max(200),
  amountMinor: minor.refine(value => value > 0), currency: z.string().regex(/^[A-Z]{3}$/),
  confirmedAt: z.iso.datetime(), simulated: z.boolean(),
}).strict();
export const confirmedReceiptsResponseSchema = z.object({
  items: z.array(confirmedReceiptSchema).max(200),
  total: minor, limit: z.number().int().min(1).max(200), offset: minor,
}).strict();
export type ConfirmedReceipt = z.infer<typeof confirmedReceiptSchema>;

export const reconciliationDecisionSchema = z.object({
  source: z.object({ kind: z.enum(['imported', 'native']), id: z.uuid(), revision: z.number().int().positive() }).strict(),
  choice: z.enum(['new', 'existing']), invoiceId: z.uuid().optional(), invoiceRevision: z.number().int().positive().optional(),
  studentIds: z.array(z.uuid()).max(100).default([]).refine(ids => new Set(ids).size === ids.length),
  payerId: z.uuid().nullable().optional(), serviceMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional(),
  dueDate: day.nullable().optional(),
  workLinks: z.array(z.object({workId: z.uuid(), revision: z.number().int().positive(), amountMinor: minor.refine(value => value > 0)}).strict()).max(200).default([])
    .refine(links => new Set(links.map(link => link.workId)).size === links.length),
  invoiceGuards: z.array(z.object({ invoiceId: z.uuid(), revision: z.number().int().positive() }).strict()).max(200).optional()
    .refine(guards => !guards || new Set(guards.map(guard => guard.invoiceId)).size === guards.length),
  confirmed: z.literal(true),
}).strict().superRefine((input, ctx) => {
  if (input.choice === 'existing' && (!input.invoiceId || !input.invoiceRevision)) ctx.addIssue({code:'custom', message:'Choose an existing invoice and its revision'});
  if (input.choice === 'new' && (input.invoiceId || input.invoiceRevision)) ctx.addIssue({code:'custom', message:'A new invoice cannot target an existing invoice'});
});
export type ReconciliationDecision = z.infer<typeof reconciliationDecisionSchema>;
