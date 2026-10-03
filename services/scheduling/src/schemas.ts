import { z } from 'zod';
export const uuid = z.string().uuid();
const fields = {
  clientId: uuid,
  title: z.string().trim().min(1).max(200),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  assignedTutorId: z.string().trim().min(1).max(128).nullable().optional(),
  subject: z.string().trim().min(1).max(100).optional(),
};
export const createSessionSchema = z.object(fields).strict().refine(
  v => Date.parse(v.endsAt) > Date.parse(v.startsAt),
  { message: 'endsAt must be after startsAt', path: ['endsAt'] },
);
export const updateSessionSchema = z.object(fields).partial().strict().refine(
  v => Object.keys(v).length > 0, { message: 'Provide at least one session field' },
);
export const listSessionsSchema = z.object({
  clientId: uuid.optional(),
  status: z.enum(['scheduled','cancelled','completed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();
export type SessionInput = z.infer<typeof createSessionSchema>;
export function validInterval(startsAt: string, endsAt: string) {
  return Date.parse(endsAt) > Date.parse(startsAt);
}
