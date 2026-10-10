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
    emailOptIn: z.boolean(),
    whatsappOptIn: z.boolean(),
    customFields: z
        .record(z.uuid(), z.union([
        z.string().max(4000),
        z.number().finite(),
        z.boolean(),
        z.null(),
    ]))
        .refine((v) => Object.keys(v).length <= 100, "At most 100 custom fields"),
};
const optionalFields = z.object(contactFields).partial().shape;
export const createClientSchema = z
    .object({
    kind: z.enum(["student", "payer"]).default("student"),
    ...optionalFields,
})
    .strict()
    .refine((v) => Boolean(v.displayName || [v.firstName, v.lastName].filter(Boolean).join(" ")), "A display name or first/last name is required");
// Kind is immutable because payer relationships depend on it.
export const updateClientSchema = z
    .object(optionalFields)
    .strict()
    .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export const filterClauseSchema = z
    .object({
    field: z.string().max(100),
    operator: z.enum([
        "contains",
        "equals",
        "gt",
        "lt",
        "is_empty",
        "is_not_empty",
    ]),
    value: z
        .union([z.string().max(4000), z.number().finite(), z.boolean()])
        .optional(),
})
    .strict()
    .refine((v) => ["is_empty", "is_not_empty"].includes(v.operator) ||
    v.value !== undefined, "Filter value is required");
const filtersSchema = z.array(filterClauseSchema).max(20);
export const clientFilterShape = {
    kind: z.enum(["student", "payer"]).optional(),
    status: contactStatusSchema.optional(),
    search: z.string().trim().max(160).optional(),
    tag: z.string().trim().min(1).max(60).optional(),
    source: z.string().trim().min(1).max(160).optional(),
    hasEmail: z.enum(["true", "false"]).optional(),
    hasPhone: z.enum(["true", "false"]).optional(),
    sortBy: z
        .union([
        z.enum(["displayName", "createdAt", "status"]),
        z.string().regex(/^custom:[0-9a-f-]{36}$/i),
    ])
        .default("createdAt"),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
    filters: z
        .preprocess((v) => {
        if (typeof v !== "string")
            return v;
        try {
            return JSON.parse(v);
        }
        catch {
            return v;
        }
    }, filtersSchema)
        .default([]),
};
export const listClientsSchema = z
    .object({
    ...clientFilterShape,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
})
    .strict();
export const recipientRequestSchema = z
    .object({
    clientIds: z.array(z.uuid()).min(1).max(2000).optional(),
    filter: z.object(clientFilterShape).strict().optional(),
})
    .strict()
    .refine((v) => Boolean(v.clientIds) !== Boolean(v.filter), "Provide either clientIds or filter");
export type ClientFilter = z.infer<typeof listClientsSchema>;
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
    "emailOptIn",
    "whatsappOptIn",
] as const;
export const importRequestSchema = z
    .object({
    rows: z
        .array(z.record(z.string().max(160), z.string().max(4000)))
        .min(1)
        .max(2000),
    mapping: z
        .record(z.union([
        z.enum(importFieldNames),
        z.string().regex(/^custom:[0-9a-f-]{36}$/i),
    ]), z.string().min(1).max(160))
        .refine((v) => Object.keys(v).length > 0, "Map at least one column"),
    duplicateMode: z.enum(["skip", "update"]).default("skip"),
    decisions: z.array(z.object({ rowNumber: z.number().int().min(2).max(2001), action: z.enum(["create", "update", "skip"]), clientId: z.uuid().optional() }).strict().refine(v => v.action === "update" ? Boolean(v.clientId) : !v.clientId, "Only update decisions require clientId")).max(2000).optional(),
})
    .strict()
    .refine((v) => v.rows.every((r) => Object.keys(r).length <= 100), "At most 100 columns per row");
export type ContactInput = z.infer<typeof createClientSchema>;
export type ContactPatch = z.infer<typeof updateClientSchema>;
export type ImportInput = z.infer<typeof importRequestSchema>;
