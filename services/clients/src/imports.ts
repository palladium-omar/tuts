import { z } from "zod";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { normalizeName } from "./student-identity.js";
import { loadFields, validateCustomValue, type FieldRow, } from "./custom-fields.js";
import type { PoolClient } from "pg";
import { contactFields, importFieldNames, type ContactInput, type ContactPatch, type ImportInput, } from "./schemas.js";
import { contactsByEmails, createContact, normalizeEmail, updateContact, item, requireClient, type ClientRow, } from "./contact-store.js";
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
        if (value === undefined ||
            value === null ||
            (typeof value === "string" && !value.trim()))
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
            ...new Set(nonblank.tags
                .split(/[,;|]/)
                .map((t) => t.trim())
                .filter(Boolean)),
        ];
    for (const field of ["emailOptIn", "whatsappOptIn"]) {
        const value = nonblank[field];
        if (typeof value === "string") {
            const normalized = value.toLowerCase();
            if (["true", "yes", "1"].includes(normalized))
                nonblank[field] = true;
            else if (["false", "no", "0"].includes(normalized))
                nonblank[field] = false;
        }
    }
    if (raw.customFields !== undefined)
        nonblank.customFields = raw.customFields;
    const parsed = incomingSchema.safeParse(nonblank);
    if (!parsed.success)
        return {
            errors: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
        };
    return { contact: parsed.data, errors: [] };
}
export type ImportPreviewRow = {
    rowNumber: number;
    action: "create" | "update" | "skip" | "error" | "review";
    candidates?: {
        id: string;
        displayName: string;
        email: string | null;
        kind: string;
        reasons: string[];
    }[];
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
    review: number;
};
export async function previewImport(tx: PoolClient, input: ImportInput) {
    const definitions = new Map<string, FieldRow>(Object.keys(input.mapping).some((key) => key.startsWith("custom:"))
        ? (await loadFields(tx)).map((field) => [field.id, field])
        : []);
    const mapped = input.rows.map((raw, index): ImportPreviewRow => {
        const values: Record<string, unknown> = {};
        const errors: string[] = [];
        for (const [field, header] of Object.entries(input.mapping)) {
            if (!(header in raw))
                errors.push(`${field}: mapped column '${header}' is missing`);
            else if (field.startsWith("custom:")) {
                const id = field.slice(7), definition = definitions.get(id), rawValue = raw[header]!.trim();
                if (!definition) {
                    errors.push(`${field}: unknown CRM field`);
                    continue;
                }
                if (!rawValue)
                    continue;
                let value: unknown = rawValue;
                if (definition.type === "number")
                    value = Number(rawValue);
                if (definition.type === "boolean") {
                    if (["true", "yes", "1"].includes(rawValue.toLowerCase()))
                        value = true;
                    else if (["false", "no", "0"].includes(rawValue.toLowerCase()))
                        value = false;
                }
                try {
                    validateCustomValue(definition, value);
                }
                catch (error) {
                    errors.push(`${field}: ${(error as Error).message}`);
                    continue;
                }
                const custom = values.customFields as Record<string, unknown> | undefined;
                values.customFields = { ...custom, [id]: value };
            }
            else
                values[field] = raw[header];
        }
        const normalized = normalizeContact(values);
        return {
            rowNumber: index + 2,
            action: "create",
            ...normalized,
            errors: [...errors, ...normalized.errors],
        };
    });
    const emails = [...new Set(mapped.map(r => r.contact?.email).filter((e): e is string => Boolean(e)))];
    const emailMatches = await contactsByEmails(tx, emails);
    const names = [...new Set(mapped.map(r => normalizeName(r.contact?.displayName || [r.contact?.firstName, r.contact?.lastName].filter(Boolean).join(' '))).filter(Boolean))];
    const nameRows = await tx.query<ClientRow>('SELECT * FROM clients WHERE merged_into IS NULL AND normalized_name=ANY($1::text[])', [names]);
    const decisions = new Map((input.decisions ?? []).map(d => [d.rowNumber, d]));
    if (decisions.size !== (input.decisions ?? []).length)
        throw new BadRequestException('Duplicate row decisions');
    if ([...decisions.keys()].some(n => n > input.rows.length + 1))
        throw new BadRequestException('Decision row is outside the import');
    const seen = new Set<string>();
    const summary: ImportSummary = { created: 0, updated: 0, skipped: 0, errors: 0, review: 0 };
    for (const row of mapped) {
        const contact = row.contact, decision = decisions.get(row.rowNumber);
        if (row.errors.length || !contact)
            row.action = 'error';
        else {
            const name = normalizeName(contact.displayName || [contact.firstName, contact.lastName].filter(Boolean).join(' '));
            const candidates = new Map<string, {
                id: string;
                displayName: string;
                email: string | null;
                kind: string;
                reasons: string[];
            }>();
            for (const c of emailMatches.get(contact.email ?? '') ?? [])
                candidates.set(c.id, { id: c.id, displayName: c.display_name, email: c.email, kind: c.kind, reasons: ['shared email (may be family)'] });
            for (const c of nameRows.rows.filter(c => normalizeName(c.display_name) === name)) {
                const found = candidates.get(c.id);
                if (found)
                    found.reasons.push('same normalized name');
                else
                    candidates.set(c.id, { id: c.id, displayName: c.display_name, email: c.email, kind: c.kind, reasons: ['same normalized name'] });
            }
            row.candidates = [...candidates.values()];
            const identity = JSON.stringify([contact.kind ?? 'student', name, contact.email ?? '', contact.phone ?? '']);
            if (decision?.action === 'skip') {
                row.action = 'skip';
                row.message = 'Skipped by review decision';
            }
            else if (decision?.action === 'update') {
                const current = await requireClient(tx, decision.clientId!);
                if (current.id !== decision.clientId) {
                    row.action = 'error';
                    row.errors.push('Selected student has merged; select its current ID');
                }
                else if (contact.kind && contact.kind !== current.kind) {
                    row.action = 'error';
                    row.errors.push('Student/payer kind cannot change');
                }
                else {
                    row.action = 'update';
                    row.clientId = current.id;
                }
            }
            else if (!name) {
                row.action = 'error';
                row.errors.push('A name is required to create a contact');
            }
            else if ((contact.displayName || [contact.firstName, contact.lastName].filter(Boolean).join(' ')).length > 160) {
                row.action = 'error';
                row.errors.push('Combined name exceeds 160 characters');
            }
            else if (decision?.action === 'create')
                row.action = 'create';
            else if (seen.has(identity)) {
                row.action = 'skip';
                row.message = 'Exact repeated name and addresses in this file';
            }
            else if (candidates.size) {
                row.action = 'review';
                row.message = 'Review the suggested identities; a shared address does not identify a student';
            }
            else
                row.action = 'create';
            if (row.action !== 'error')
                seen.add(identity);
        }
        if (row.action === 'create')
            summary.created++;
        else if (row.action === 'update')
            summary.updated++;
        else if (row.action === 'skip')
            summary.skipped++;
        else if (row.action === 'review')
            summary.review++;
        else
            summary.errors++;
    }
    return { rows: mapped, summary };
}
export async function commitImport(tx: PoolClient, businessId: string, input: ImportInput, correlationId: string) {
    const preview = await previewImport(tx, input);
    if (preview.summary.review)
        throw new ConflictException("Resolve all identity review rows before importing");
    for (const row of preview.rows) {
        if (row.action === "create")
            await createContact(tx, businessId, {
                ...row.contact!,
                kind: row.contact!.kind ?? "student",
                source: row.contact!.source ?? "file-import",
            } as ContactInput, correlationId);
        else if (row.action === "update") {
            const { kind: _, ...patch } = row.contact!;
            await updateContact(tx, businessId, row.clientId!, patch as ContactPatch, correlationId);
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
