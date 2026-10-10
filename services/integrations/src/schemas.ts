import { z } from "zod";
const path = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
  .refine(
    (v) =>
      !v
        .split(".")
        .some((p) => ["__proto__", "prototype", "constructor"].includes(p)),
    "Unsafe field path",
  );
export const mappingSchema = z
  .object({
    externalId: path.optional(),
    firstName: path.optional(),
    lastName: path.optional(),
    displayName: path.optional(),
    email: path.optional(),
    phone: path.optional(),
    notes: path.optional(),
    status: path.optional(),
    tags: path.optional(),
  })
  .strict();
const publicUrl = z
  .string()
  .max(2048)
  .url()
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.hash &&
        (!u.port || u.port === "443")
      );
    } catch {
      return false;
    }
  }, "Use an HTTPS URL on port 443 without embedded credentials");
export const configSchema = z
  .object({
    url: publicUrl.optional(),
    bookingUrl: publicUrl.optional(),
    mapping: mappingSchema.optional(),
    recordsPath: path.optional(),
  })
  .strict();
export const connectionSchema = z
  .object({
    provider: z.enum(["calendly", "calcom", "json_api", "form_webhook"]),
    displayName: z.string().trim().min(1).max(100),
    credentials: z
      .object({
        token: z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[^\r\n]+$/)
          .optional(),
      })
      .strict()
      .default({}),
    config: configSchema.default({}),
  })
  .strict()
  .superRefine((v, c) => {
    if (["calendly", "calcom"].includes(v.provider) && !v.credentials.token)
      c.addIssue({
        code: "custom",
        path: ["credentials", "token"],
        message: "Provider token required",
      });
    if (
      v.provider === "calcom" &&
      v.credentials.token &&
      !v.credentials.token.startsWith("cal_")
    )
      c.addIssue({
        code: "custom",
        path: ["credentials", "token"],
        message: "Cal.com API key must start with cal_",
      });
    if (v.provider === "json_api" && !v.config.url)
      c.addIssue({
        code: "custom",
        path: ["config", "url"],
        message: "Contact JSON endpoint required",
      });
  });
export type Config = z.infer<typeof configSchema>;
export type Provider = z.infer<typeof connectionSchema>["provider"];
export const contactSchema = z
  .object({
    externalId: z.string().min(1).max(320),
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
    displayName: z.string().min(1).max(160).optional(),
    email: z.string().email().max(254).optional(),
    phone: z.string().min(3).max(40).optional(),
    notes: z.string().max(4000).optional(),
    status: z.enum(["lead", "active", "inactive"]).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  })
  .strict();
export type Contact = z.infer<typeof contactSchema>;
export type ExternalSession = {
  externalId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "cancelled" | "completed" | "no_show";
  attendeeName?: string;
  attendeeEmail?: string;
  bookingUrl?: string;
  providerUpdatedAt?: string;
  revisionSource?: "provider" | "observed";
};
