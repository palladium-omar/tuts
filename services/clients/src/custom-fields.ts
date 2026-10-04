import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";

export const fieldTypeSchema = z.enum([
  "text",
  "number",
  "date",
  "select",
  "boolean",
]);
export type FieldType = z.infer<typeof fieldTypeSchema>;
const optionsSchema = z
  .array(z.string().trim().min(1).max(120))
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length, "Options must be unique");
export const createFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    type: fieldTypeSchema,
    options: optionsSchema.optional(),
  })
  .strict()
  .refine(
    (v) => (v.type === "select" ? Boolean(v.options) : v.options === undefined),
    "Only select fields require options",
  );
export const updateFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    options: optionsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export type FieldRow = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  created_at: Date;
};
export const fieldItem = (row: FieldRow) => ({
  id: row.id,
  key: row.key,
  label: row.label,
  type: row.type,
  ...(row.type === "select" ? { options: row.options ?? [] } : {}),
  createdAt: row.created_at,
});
export async function loadFields(tx: PoolClient) {
  return (
    await tx.query<FieldRow>(
      "SELECT id,key,label,type,options,created_at FROM client_fields ORDER BY created_at,id",
    )
  ).rows;
}
export async function requireField(tx: PoolClient, id: string) {
  const field = (
    await tx.query<FieldRow>(
      "SELECT id,key,label,type,options,created_at FROM client_fields WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!field) throw new NotFoundException("CRM field was not found");
  return field;
}
export function validateCustomValue(
  field: FieldRow,
  value: unknown,
): asserts value is string | number | boolean | null {
  if (value === null) return;
  let valid = false;
  switch (field.type) {
    case "text":
      valid = typeof value === "string" && value.length <= 4000;
      break;
    case "number":
      valid = typeof value === "number" && Number.isFinite(value);
      break;
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "select":
      valid =
        typeof value === "string" && Boolean(field.options?.includes(value));
      break;
    case "date":
      valid =
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value;
      break;
  }
  if (!valid)
    throw new BadRequestException(
      `Invalid value for CRM field '${field.label}' (${field.type})`,
    );
}
export async function validateCustomFields(
  tx: PoolClient,
  values: Record<string, string | number | boolean | null>,
) {
  if (!Object.keys(values).length) return;
  const definitions = new Map((await loadFields(tx)).map((f) => [f.id, f]));
  for (const [id, value] of Object.entries(values)) {
    const field = definitions.get(id);
    if (!field) throw new BadRequestException(`Unknown CRM field '${id}'`);
    validateCustomValue(field, value);
  }
}
