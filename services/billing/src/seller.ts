import { z } from "zod";
// Service-owned wire validation; billing never reads the platform database.
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .optional();
export const sellerEventSchema = z
  .object({
    businessId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    profile: z
      .object({
        legalName: text(200),
        email: z.email().max(254).nullable().optional(),
        phone: text(50),
        website: z
          .url()
          .max(2048)
          .refine((v) => ["http:", "https:"].includes(new URL(v).protocol))
          .nullable()
          .optional(),
        taxId: text(100),
        address: z
          .object({
            line1: text(200),
            line2: text(200),
            city: text(120),
            region: text(120),
            postalCode: text(30),
            country: text(100),
          })
          .strict()
          .nullable()
          .optional(),
      })
      .strict(),
    branding: z
      .object({
        displayName: z.string().trim().min(1).max(120).optional(),
        primaryColor: color,
        secondaryColor: color,
        backgroundColor: color,
        textColor: color,
        logoUrl: z
          .url()
          .max(2048)
          .refine((v) => v.startsWith("https://"))
          .nullable()
          .optional(),
        logoDataUrl: z
          .string()
          .max(350000)
          .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
          .nullable()
          .optional(),
      })
      .strict(),
  })
  .strict();
