import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { ClientFilter } from "./schemas.js";
import {
  loadFields,
  validateCustomValue,
  type FieldRow,
  type FieldType,
} from "./custom-fields.js";

const builtin = {
  displayName: ["display_name", "text"],
  firstName: ["first_name", "text"],
  lastName: ["last_name", "text"],
  email: ["email", "text"],
  phone: ["phone", "text"],
  status: ["status", "select"],
  kind: ["kind", "select"],
  source: ["source", "text"],
  tags: ["array_to_string(tags,', ')", "text"],
  createdAt: ["created_at", "date"],
  emailOptIn: ["email_opt_in", "boolean"],
  whatsappOptIn: ["whatsapp_opt_in", "boolean"],
} as const;
const literalPattern = (value: string) =>
  `%${value.replace(/[\\%_]/g, "\\$&")}%`;
export async function buildClientQuery(
  tx: PoolClient,
  input: Omit<ClientFilter, "limit" | "offset">,
) {
  const values: unknown[] = [];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions: string[] = ["merged_into IS NULL"];
  const fields = new Map((await loadFields(tx)).map((f) => [f.id, f]));
  function customExpression(field: FieldRow) {
    const key = add(field.id);
    const raw = `(custom_fields -> ${key}::text)`;
    const text = `(custom_fields ->> ${key}::text)`;
    if (field.type === "number")
      return `CASE WHEN jsonb_typeof(${raw})='number' THEN ${text}::numeric END`;
    if (field.type === "boolean")
      return `CASE WHEN jsonb_typeof(${raw})='boolean' THEN ${text}::boolean END`;
    // Validated dates are ISO yyyy-mm-dd, so lexical comparison has date ordering and avoids unsafe SQL casts.
    return text;
  }
  function resolve(name: string): {
    expression: string;
    type: FieldType;
    definition?: FieldRow;
  } {
    if (name.startsWith("custom:")) {
      const field = fields.get(name.slice(7));
      if (!field) throw new BadRequestException(`Unknown CRM field '${name}'`);
      return {
        expression: customExpression(field),
        type: field.type,
        definition: field,
      };
    }
    const value = builtin[name as keyof typeof builtin];
    if (!value)
      throw new BadRequestException(`Unsupported filter field '${name}'`);
    return { expression: value[0], type: value[1] };
  }
  if (input.kind) conditions.push(`kind=${add(input.kind)}`);
  if (input.status) conditions.push(`status=${add(input.status)}`);
  if (input.source) conditions.push(`source=${add(input.source)}`);
  if (input.tag) conditions.push(`${add(input.tag)}=ANY(tags)`);
  for (const [name, column] of [
    ["hasEmail", "email"],
    ["hasPhone", "phone"],
  ] as const) {
    if (input[name])
      conditions.push(
        input[name] === "true"
          ? `(${column} IS NOT NULL AND btrim(${column})<>'')`
          : `(${column} IS NULL OR btrim(${column})='')`,
      );
  }
  if (input.search) {
    const pattern = add(literalPattern(input.search));
    conditions.push(
      `(display_name ILIKE ${pattern} OR first_name ILIKE ${pattern} OR last_name ILIKE ${pattern} OR email ILIKE ${pattern} OR phone ILIKE ${pattern} OR array_to_string(tags,', ') ILIKE ${pattern})`,
    );
  }
  for (const clause of input.filters) {
    const { expression, type, definition } = resolve(clause.field);
    const empty = `${expression} IS NULL${type === "text" || type === "select" || (type === "date" && definition) ? ` OR ${expression}=''` : ""}`;
    if (clause.operator === "is_empty" || clause.operator === "is_not_empty") {
      conditions.push(
        clause.operator === "is_empty" ? `(${empty})` : `NOT (${empty})`,
      );
      continue;
    }
    if (clause.operator === "contains" && type !== "text")
      throw new BadRequestException(
        `contains requires a text field ('${clause.field}')`,
      );
    if (
      (clause.operator === "gt" || clause.operator === "lt") &&
      type !== "number" &&
      type !== "date"
    )
      throw new BadRequestException(
        `gt/lt require a number or date field ('${clause.field}')`,
      );
    if (definition) validateCustomValue(definition, clause.value);
    else if (
      type === "boolean"
        ? typeof clause.value !== "boolean"
        : typeof clause.value !== "string"
    )
      throw new BadRequestException(
        `Invalid filter value for '${clause.field}'`,
      );
    if (
      !definition &&
      type === "date" &&
      (typeof clause.value !== "string" ||
        Number.isNaN(Date.parse(clause.value)))
    )
      throw new BadRequestException("Invalid createdAt filter date");
    const parameter = add(
      clause.operator === "contains"
        ? literalPattern(clause.value as string)
        : clause.value,
    );
    conditions.push(
      `${expression} ${clause.operator === "contains" ? "ILIKE" : clause.operator === "equals" ? "=" : clause.operator === "gt" ? ">" : "<"} ${parameter}`,
    );
  }
  const countValues = [...values];
  const sort = resolve(input.sortBy);
  return {
    countValues,
    where: conditions.length ? conditions.join(" AND ") : "TRUE",
    order: `${sort.expression} ${input.sortDirection === "asc" ? "ASC" : "DESC"} NULLS LAST,id ASC`,
    values,
  };
}
