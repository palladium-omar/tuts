import { z } from 'zod';
export const clientIdSchema = z.uuid();
const fields = {
  displayName: z.string().trim().min(1).max(160),
  email: z.email().max(320).nullable().optional(),
  phone: z.string().trim().min(3).max(40).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
};
export const createClientSchema = z.object({ kind: z.enum(['student', 'payer']).default('student'), ...fields }).strict();
// Kind is immutable because payer relationships depend on it.
export const updateClientSchema = z.object(fields).partial().strict().refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export const listClientsSchema = z.object({
  kind: z.enum(['student', 'payer']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
export const payerRelationshipSchema = z.object({ payerId: clientIdSchema, relationship: z.enum(['parent', 'guardian', 'sponsor', 'self', 'other']).default('parent') }).strict();
