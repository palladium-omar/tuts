import { BadRequestException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { emitEvent } from "@palladium/service-kit";
import type { ContactInput, ContactPatch } from "./schemas.js";
import { normalizeName, syncLegacyContact } from "./student-identity.js";
import { validateCustomFields } from "./custom-fields.js";
export type ClientRow = {
  id: string;
  photo: string | null;
  revision: number;
  merged_into: string | null;
  portal_protected_at: Date | null;
  kind: "student" | "payer";
  display_name: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: "lead" | "active" | "inactive";
  tags: string[];
  source: string | null;
  custom_fields: Record<string, string | number | boolean | null>;
  email_opt_in: boolean;
  whatsapp_opt_in: boolean;
  created_at: Date;
  updated_at: Date;
};
export const item = (r: ClientRow) => ({
  id: r.id,
  photo: r.photo ?? null,
  kind: r.kind,
  revision: r.revision,
  portalProtected: Boolean(r.portal_protected_at),
  firstName: r.first_name,
  lastName: r.last_name,
  displayName: r.display_name,
  email: r.email,
  phone: r.phone,
  notes: r.notes,
  status: r.status,
  tags: r.tags,
  source: r.source,
  customFields: r.custom_fields ?? {},
  emailOptIn: r.email_opt_in ?? false,
  whatsappOptIn: r.whatsapp_opt_in ?? false,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export async function requireClient(
  tx: PoolClient,
  id: string,
): Promise<ClientRow> {
  const result = await tx.query<ClientRow>(
    `WITH RECURSIVE canonical AS (SELECT * FROM clients WHERE id=$1 UNION ALL SELECT c.* FROM clients c JOIN canonical a ON c.id=a.merged_into AND c.business_id=a.business_id) SELECT * FROM canonical WHERE merged_into IS NULL LIMIT 1`,
    [id],
  );
  if (!result.rows[0]) throw new NotFoundException("Client was not found");
  return result.rows[0];
}
// Serializes mutations that depend on email matching, including concurrent imports and connector events.
export async function lockContacts(tx: PoolClient, businessId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `clients:${businessId}`,
  ]);
}
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export async function createContact(
  tx: PoolClient,
  businessId: string,
  input: ContactInput,
  correlationId?: string,
) {
  await validateCustomFields(tx, input.customFields ?? {});
  const id = randomUUID();
  const displayName =
    input.displayName ||
    [input.firstName, input.lastName].filter(Boolean).join(" ");
  if (displayName.length > 160)
    throw new BadRequestException(
      "Combined first and last name must fit within 160 characters, or provide a shorter displayName",
    );
  const result = await tx.query<ClientRow>(
    `INSERT INTO clients
    (business_id,id,kind,display_name,first_name,last_name,email,phone,notes,status,tags,source,custom_fields,email_opt_in,whatsapp_opt_in,photo)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16) RETURNING *`,
    [
      businessId,
      id,
      input.kind,
      displayName,
      input.firstName ?? "",
      input.lastName ?? "",
      input.email ? normalizeEmail(input.email) : null,
      input.phone ?? null,
      input.notes ?? null,
      input.status ?? "lead",
      [...new Set(input.tags ?? [])],
      input.source ?? null,
      JSON.stringify(input.customFields ?? {}),
      input.emailOptIn ?? false,
      input.whatsappOptIn ?? false,
      input.photo ?? null,
    ],
  );
  await tx.query("UPDATE clients SET normalized_name=$2 WHERE id=$1", [id, normalizeName(displayName)]);
  await syncLegacyContact(tx, businessId, result.rows[0]!);
  await emitEvent(tx, {
    type: "clients.client-created.v1",
    producer: "clients",
    businessId,
    correlationId,
    data: {
      clientId: id,
      emailOptIn: result.rows[0]!.email_opt_in ?? false,
      whatsappOptIn: result.rows[0]!.whatsapp_opt_in ?? false,
    },
  });
  return result.rows[0]!;
}
const columns = {
  photo: "photo",
  firstName: "first_name",
  lastName: "last_name",
  displayName: "display_name",
  email: "email",
  phone: "phone",
  notes: "notes",
  status: "status",
  tags: "tags",
  source: "source",
  customFields: "custom_fields",
  emailOptIn: "email_opt_in",
  whatsappOptIn: "whatsapp_opt_in",
} as const;
export async function updateContact(
  tx: PoolClient,
  businessId: string,
  id: string,
  input: ContactPatch,
  correlationId?: string,
  composeName = true,
  syncRelated = true,
) {
  await validateCustomFields(tx, input.customFields ?? {});
  const currentCanonical = await requireClient(tx, id);
  id = currentCanonical.id;
  const patch = { ...input };
  if (patch.email) patch.email = normalizeEmail(patch.email);
  if (patch.tags) patch.tags = [...new Set(patch.tags)];
  // Keep partial name edits coherent when the caller has not explicitly chosen a display name.
  if (
    composeName &&
    !("displayName" in patch) &&
    ("firstName" in patch || "lastName" in patch)
  ) {
    const current = await requireClient(tx, id);
    const composed = [
      patch.firstName ?? current.first_name,
      patch.lastName ?? current.last_name,
    ]
      .filter(Boolean)
      .join(" ");
    if (composed.length > 160)
      throw new BadRequestException(
        "Combined first and last name must fit within 160 characters, or provide a shorter displayName",
      );
    if (composed) patch.displayName = composed;
  }
  const values: unknown[] = [id];
  const assignments = Object.entries(patch).map(([key, value]) => {
    const column = columns[key as keyof typeof columns];
    if (!column) throw new Error("Unsupported client field");
    values.push(key === "customFields" ? JSON.stringify(value) : value);
    return key === "customFields"
      ? `custom_fields=custom_fields || $${values.length}::jsonb`
      : `${column}=$${values.length}`;
  });
  if (!assignments.length) return requireClient(tx, id);
  const result = await tx.query<ClientRow>(
    `UPDATE clients SET ${assignments.join(",")},updated_at=now(),revision=revision+1 WHERE id=$1 RETURNING *`,
    values,
  );
  if (!result.rows[0]) throw new NotFoundException("Client was not found");
  await tx.query("UPDATE clients SET normalized_name=$2 WHERE id=$1", [id, normalizeName(result.rows[0]!.display_name)]);
  if (syncRelated) await syncLegacyContact(tx, businessId, result.rows[0]!);
  await emitEvent(tx, {
    type: "clients.client-updated.v1",
    producer: "clients",
    businessId,
    correlationId,
    data: {
      clientId: id,
      emailOptIn: result.rows[0]!.email_opt_in ?? false,
      whatsappOptIn: result.rows[0]!.whatsapp_opt_in ?? false,
    },
  });
  return result.rows[0];
}
export async function contactsByEmails(tx: PoolClient, emails: string[]) {
  const result = await tx.query<ClientRow>(
    "SELECT * FROM clients WHERE merged_into IS NULL AND lower(btrim(email))=ANY($1::text[]) ORDER BY id",
    [emails],
  );
  const matches = new Map<string, ClientRow[]>();
  for (const row of result.rows) {
    const key = normalizeEmail(row.email!);
    matches.set(key, [...(matches.get(key) ?? []), row]);
  }
  return matches;
}
