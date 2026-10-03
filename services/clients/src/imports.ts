import { z } from "zod";
import type { PoolClient } from "pg";
import {
  contactFields,
  importFieldNames,
  type ContactInput,
  type ContactPatch,
  type ImportInput,
} from "./schemas.js";
import {
  contactsByEmails,
  createContact,
  normalizeEmail,
  updateContact,
} from "./contact-store.js";
const incomingSchema = z
  .object({
    ...z.object(contactFields).partial().shape,
    kind: z.enum(["student", "payer"]).optional(),
  })
  .strict();
export type IncomingContact = z.infer<typeof incomingSchema>;
export function normalizeContact(raw: Record<string, unknown>): {
  contact?: IncomingContact;
  errors: string[];
} {
  const nonblank: Record<string, unknown> = {};
  for (const key of importFieldNames) {
    const value = raw[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim())
    )
      continue;
    nonblank[key] = typeof value === "string" ? value.trim() : value;
  }
  if (typeof nonblank.email === "string")
    nonblank.email = normalizeEmail(nonblank.email);
  if (typeof nonblank.status === "string")
    nonblank.status = nonblank.status.toLowerCase();
  if (typeof nonblank.kind === "string")
    nonblank.kind = nonblank.kind.toLowerCase();
  if (typeof nonblank.tags === "string")
    nonblank.tags = [
      ...new Set(
        nonblank.tags
          .split(/[,;|]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
  const parsed = incomingSchema.safeParse(nonblank);
  if (!parsed.success)
    return {
      errors: parsed.error.issues.map(
        (e) => `${e.path.join(".")}: ${e.message}`,
      ),
    };
  return { contact: parsed.data, errors: [] };
}
export type ImportPreviewRow = {
  rowNumber: number;
  action: "create" | "update" | "skip" | "error";
  clientId?: string;
  contact?: IncomingContact;
  errors: string[];
  message?: string;
};
export type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
};
export async function previewImport(tx: PoolClient, input: ImportInput) {
  const mapped = input.rows.map((raw, index): ImportPreviewRow => {
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const [field, header] of Object.entries(input.mapping)) {
      if (!(header in raw))
        errors.push(`${field}: mapped column '${header}' is missing`);
      else values[field] = raw[header];
    }
    const normalized = normalizeContact(values);
    return {
      rowNumber: index + 2,
      action: "create",
      ...normalized,
      errors: [...errors, ...normalized.errors],
    };
  });
  const emails = [
    ...new Set(
      mapped
        .map((r) => r.contact?.email)
        .filter((e): e is string => Boolean(e)),
    ),
  ];
  const matches = await contactsByEmails(tx, emails);
  const seen = new Set<string>();
  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };
  for (const row of mapped) {
    const contact = row.contact;
    if (row.errors.length || !contact) row.action = "error";
    else if (!contact.email) {
      row.action = "skip";
      row.message =
        "Email is required for safe import matching; add an email or create this contact manually.";
    } else {
      const email = normalizeEmail(contact.email);
      const found = matches.get(email) ?? [];
      if (found.length > 1) {
        row.action = "error";
        row.errors.push(
          "Email matches multiple existing contacts. Resolve these duplicates before importing.",
        );
      } else if (seen.has(email)) {
        row.action = "skip";
        row.message =
          "Duplicate email in this file; only the first valid row is used.";
      } else if (found[0]) {
        row.clientId = found[0].id;
        if (contact.kind && contact.kind !== found[0].kind) {
          row.action = "error";
          row.errors.push(
            "Student/payer kind cannot be changed for an existing contact.",
          );
        } else if (
          !contact.displayName &&
          ("firstName" in contact || "lastName" in contact) &&
          [
            contact.firstName ?? found[0].first_name,
            contact.lastName ?? found[0].last_name,
          ]
            .filter(Boolean)
            .join(" ").length > 160
        ) {
          row.action = "error";
          row.errors.push(
            "Combined name exceeds 160 characters; map a shorter display name.",
          );
        } else if (input.duplicateMode === "skip") {
          row.action = "skip";
          row.message = "Email already exists in the CRM.";
          seen.add(email);
        } else {
          row.action = "update";
          seen.add(email);
        }
      } else if (
        !contact.displayName &&
        [contact.firstName, contact.lastName].filter(Boolean).join(" ").length >
          160
      ) {
        row.action = "error";
        row.errors.push(
          "Combined name exceeds 160 characters; map a shorter display name.",
        );
      } else if (
        !contact.displayName &&
        ![contact.firstName, contact.lastName].filter(Boolean).join(" ")
      ) {
        row.action = "error";
        row.errors.push(
          "A display name or first/last name is required for a new contact.",
        );
      } else {
        row.action = "create";
        seen.add(email);
      }
    }
    summary[
      row.action === "create"
        ? "created"
        : row.action === "update"
          ? "updated"
          : row.action === "skip"
            ? "skipped"
            : "errors"
    ]++;
  }
  return { rows: mapped, summary };
}
export async function commitImport(
  tx: PoolClient,
  businessId: string,
  input: ImportInput,
  correlationId: string,
) {
  const preview = await previewImport(tx, input);
  for (const row of preview.rows) {
    if (row.action === "create")
      await createContact(
        tx,
        businessId,
        {
          ...row.contact!,
          kind: row.contact!.kind ?? "student",
          source: row.contact!.source ?? "file-import",
        } as ContactInput,
        correlationId,
      );
    else if (row.action === "update") {
      const { kind: _, ...patch } = row.contact!;
      await updateContact(
        tx,
        businessId,
        row.clientId!,
        patch as ContactPatch,
        correlationId,
      );
    }
  }
  return {
    ...preview.summary,
    errors: preview.rows
      .filter((r) => r.action === "error")
      .map((r) => ({ rowNumber: r.rowNumber, messages: r.errors })),
    skippedRows: preview.rows
      .filter((r) => r.action === "skip")
      .map((r) => ({ rowNumber: r.rowNumber, message: r.message })),
  };
}
