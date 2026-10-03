import { z } from 'zod';

export const businessIdSchema = z.uuid();
export const timezoneSchema = z.string().max(80).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}, 'Invalid IANA timezone');
export const businessSchema = z.object({ name: z.string().trim().min(1).max(120), timezone: timezoneSchema.default('UTC') }).strict();
export const brandingSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  logoUrl: z.url().max(2048).refine((v) => v.startsWith('https://'), 'Logo URL must use HTTPS').nullable().optional(),
}).strict();
export const settingsSchema = z.object({
  branding: brandingSchema.optional(), timezone: timezoneSchema.optional(),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'At least one setting is required');
export const internalContextSchema = z.object({ businessId: businessIdSchema }).strict();
export const STARTER_ENTITLEMENTS = ['clients', 'scheduling', 'learning', 'billing', 'payments', 'notifications'];
export function starterEntitlements(environment = process.env.NODE_ENV): string[] {
  return environment === 'production' ? [] : [...STARTER_ENTITLEMENTS];
}
