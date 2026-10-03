import { z } from "zod";
export const clientIdSchema = z.uuid();
export const contactStatusSchema = z.enum(["lead", "active", "inactive"]);
export const contactFields = {
  firstName: z.string().trim().max(80),
  lastName: z.string().trim().max(80),
  displayName: z.string().trim().min(1).max(160),
  email: z.email().max(320).nullable(),
  phone: z.string().trim().min(3).max(40).nullable(),
  notes: z.string().max(4000).nullable(),
  status: contactStatusSchema,
  tags: z.array(z.string().trim().min(1).max(60)).max(30),
  source: z.string().trim().min(1).max(160).nullable(),
};
const optionalFields = z.object(contactFields).partial().shape;
export const createClientSchema = z
  .object({
    kind: z.enum(["student", "payer"]).default("student"),
    ...optionalFields,
  })
  .strict()
  .refine(
    (v) =>
      Boolean(
        v.displayName || [v.firstName, v.lastName].filter(Boolean).join(" "),
      ),
    "A display name or first/last name is required",
  );
// Kind is immutable because payer relationships depend on it.
export const updateClientSchema = z
  .object(optionalFields)
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export const listClientsSchema = z
  .object({
    kind: z.enum(["student", "payer"]).optional(),
    status: contactStatusSchema.optional(),
    search: z.string().trim().max(160).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const payerRelationshipSchema = z
  .object({
    payerId: clientIdSchema,
    relationship: z
      .enum(["parent", "guardian", "sponsor", "self", "other"])
      .default("parent"),
  })
  .strict();
export const importFieldNames = [
  "firstName",
  "lastName",
  "displayName",
  "email",
  "phone",
  "notes",
  "status",
  "tags",
  "kind",
  "source",
] as const;
export const importRequestSchema = z
  .object({
    rows: z
      .array(z.record(z.string().max(160), z.string().max(4000)))
      .min(1)
      .max(2000),
    mapping: z
      .partialRecord(z.enum(importFieldNames), z.string().min(1).max(160))
      .refine((v) => Object.keys(v).length > 0, "Map at least one column"),
    duplicateMode: z.enum(["skip", "update"]).default("skip"),
  })
  .strict()
  .refine(
    (v) => v.rows.every((r) => Object.keys(r).length <= 100),
    "At most 100 columns per row",
  );
export type ContactInput = z.infer<typeof createClientSchema>;
export type ContactPatch = z.infer<typeof updateClientSchema>;
export type ImportInput = z.infer<typeof importRequestSchema>;
