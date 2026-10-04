import { z } from "zod";
const uuid = z.string().uuid();
const header = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]+$/);
const email = z.string().email().max(254);
const secret = z.string().min(1).max(10000);
const credentialHeader = secret.regex(/^[^\r\n]+$/);
const sender = z
  .object({ fromEmail: email, fromName: header.max(100).optional() })
  .strict();
export const connectionSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("smtp"),
      displayName: header.max(100),
      config: sender
        .extend({
          host: z
            .string()
            .trim()
            .min(1)
            .max(253)
            .regex(/^[a-zA-Z0-9.-]+$/),
          port: z.union([z.literal(465), z.literal(587)]),
        })
        .strict(),
      credentials: z.object({ username: header, password: secret }).strict(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("resend"),
      displayName: header.max(100),
      config: sender,
      credentials: z.object({ apiKey: credentialHeader }).strict(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("whatsapp_business"),
      displayName: header.max(100),
      config: z
        .object({
          phoneNumberId: z.string().regex(/^\d{5,30}$/),
          apiVersion: z.string().regex(/^v\d{1,2}\.0$/),
        })
        .strict(),
      credentials: z.object({ accessToken: credentialHeader }).strict(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("ai_agent"),
      displayName: header.max(100),
      config: z.object({ endpointUrl: z.string().url().max(2000) }).strict(),
      credentials: z
        .object({ bearerToken: credentialHeader.optional() })
        .strict(),
    })
    .strict(),
]);
export type ConnectionInput = z.infer<typeof connectionSchema>;
export const connectionPatchSchema = z
  .object({
    displayName: header.max(100).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const templateSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/),
    language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
    parameters: z.array(z.string().max(2000)).max(30).default([]),
  })
  .strict();
export const selectionSchema = z
  .object({
    clientIds: z.array(uuid).min(1).max(2000).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => !(v.clientIds && v.filter), "Choose IDs or a filter");
export const campaignSchema = z
  .object({
    connectionId: uuid,
    channel: z.enum(["email", "whatsapp"]),
    selection: selectionSchema,
    subject: header.max(200).optional(),
    message: z.string().trim().min(1).max(10000).optional(),
    template: templateSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.channel === "email" && (!v.subject || !v.message || v.template))
      ctx.addIssue({
        code: "custom",
        message: "Email requires subject/message and no template",
      });
    if (v.channel === "whatsapp" && (!v.template || v.subject || v.message))
      ctx.addIssue({
        code: "custom",
        message:
          "WhatsApp campaigns require an approved template, not free text",
      });
  });
export const generateSchema = z
  .object({
    instruction: z.string().trim().min(1).max(4000),
    subject: z.string().max(200).optional(),
    message: z.string().max(10000).optional(),
  })
  .strict();
export const generatedSchema = z
  .object({
    subject: header.max(200),
    message: z.string().trim().min(1).max(10000),
  })
  .strict();
export const sendSchema = z
  .object({ confirmationToken: z.string().regex(/^[a-f\d]{64}$/) })
  .strict();
export const contactSchema = z.object({
  id: uuid,
  displayName: z.string().max(300),
  firstName: z.string().max(200).nullable().optional(),
  lastName: z.string().max(200).nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  emailOptIn: z.boolean(),
  whatsappOptIn: z.boolean(),
  customFields: z.record(z.string(), z.unknown()).default({}),
});
export const recipientsSchema = z.object({
  items: z.array(contactSchema).max(2000),
  total: z.number().int().min(0),
  truncated: z.boolean(),
});
export type Contact = z.infer<typeof contactSchema>;
export type Template = z.infer<typeof templateSchema>;
export const consentSchema = z.object({
  clientId: uuid,
  emailOptIn: z.boolean().optional(),
  whatsappOptIn: z.boolean().optional(),
});
export function personalize(text: string, contact: Contact) {
  const replaced = text.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => {
    if (name === "firstName" || name === "lastName" || name === "displayName")
      return contact[name] ?? "";
    if (
      /^custom:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
        name,
      )
    ) {
      const value = contact.customFields[name.slice(7)];
      return typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
        ? String(value)
        : "";
    }
    throw new Error("Unsupported personalization field");
  });
  if (/\{\{|\}\}/.test(replaced))
    throw new Error("Invalid personalization field");
  if (replaced.length > 15000)
    throw new Error("Personalized content is too long");
  return replaced;
}
export function eligibility(
  contact: Contact,
  channel: "email" | "whatsapp",
): {
  address: string | null;
  reason: string | null;
} {
  if (!(channel === "email" ? contact.emailOptIn : contact.whatsappOptIn))
    return { address: null, reason: "consent_required" };
  const address =
    (channel === "email" ? contact.email : contact.phone)?.trim() ?? "";
  if (
    !(channel === "email"
      ? email.safeParse(address).success
      : /^\+[1-9]\d{6,14}$/.test(address))
  )
    return { address: null, reason: "invalid_address" };
  return { address, reason: null };
}
