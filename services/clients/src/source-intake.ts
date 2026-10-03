import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { PoolClient } from "pg";
import { emitEvent, EventBus } from "@palladium/service-kit";
import type { PlatformEvent } from "@palladium/contracts";
import {
  contactsByEmails,
  createContact,
  lockContacts,
  normalizeEmail,
  requireClient,
  updateContact,
  type ClientRow,
} from "./contact-store.js";
import { normalizeContact, type IncomingContact } from "./imports.js";
import type { ContactInput, ContactPatch } from "./schemas.js";
const envelopeSchema = z
  .object({
    connectionId: z.uuid(),
    source: z.string().trim().min(1).max(160),
    contacts: z.array(z.unknown()).max(200),
  })
  .strict();
const disconnectSchema = z.object({ connectionId: z.uuid() }).strict();
async function lockSource(
  tx: PoolClient,
  businessId: string,
  connectionId: string,
) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `client-source:${businessId}:${connectionId}`,
  ]);
}
const externalIdSchema = z.string().trim().min(1).max(320);
const allowed = new Set([
  "externalId",
  "firstName",
  "lastName",
  "displayName",
  "email",
  "phone",
  "notes",
  "status",
  "tags",
]);
const crmValues = (row: ClientRow): Record<string, unknown> => ({
  firstName: row.first_name,
  lastName: row.last_name,
  displayName: row.display_name,
  email: row.email,
  phone: row.phone,
  notes: row.notes,
  status: row.status,
  tags: row.tags,
  source: row.source,
});
function blank(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}
function blankPatch(current: ClientRow, incoming: IncomingContact) {
  const values = crmValues(current),
    patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming))
    if (key !== "kind" && blank(values[key]) && !blank(value))
      patch[key] = value;
  return patch as ContactPatch;
}
@Injectable()
export class SourceIntake implements OnModuleInit {
  constructor(@Inject(EventBus) private readonly events: EventBus) {}
  onModuleInit() {
    this.events.subscribe("integrations.contacts-received.v1", (event, tx) =>
      this.receive(event, tx),
    );
    this.events.subscribe(
      "integrations.connection-disconnected.v1",
      (event, tx) => this.disconnect(event, tx),
    );
  }
  async disconnect(event: PlatformEvent, tx: PoolClient) {
    if (event.producer !== "integrations")
      throw new Error("Invalid contact source producer");
    const input = disconnectSchema.parse(event.data);
    // Both handlers take locks in this order; disconnect commits before any
    // later delivery for this source can check its persisted tombstone.
    await lockContacts(tx, event.businessId);
    await lockSource(tx, event.businessId, input.connectionId);
    await tx.query(
      "INSERT INTO disconnected_client_sources(business_id,connection_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [event.businessId, input.connectionId],
    );
  }
  async receive(event: PlatformEvent, tx: PoolClient) {
    if (event.producer !== "integrations")
      throw new Error("Invalid contact source producer");
    const input = envelopeSchema.parse(event.data);
    await lockContacts(tx, event.businessId);
    await lockSource(tx, event.businessId, input.connectionId);
    const disconnected = await tx.query(
      "SELECT 1 FROM disconnected_client_sources WHERE business_id=$1 AND connection_id=$2",
      [event.businessId, input.connectionId],
    );
    if (disconnected.rowCount) return;
    const result = {
      connectionId: input.connectionId,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      issues: [] as { externalId: string; reason: string }[],
    };
    const seen = new Set<string>();
    const issue = (externalId: string, reason: string) => {
      result.skipped++;
      result.errors++;
      result.issues.push({ externalId, reason });
    };
    for (let i = 0; i < input.contacts.length; i++) {
      const raw = input.contacts[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        issue(`row:${i + 1}`, "Contact must be an object");
        continue;
      }
      const fields = raw as Record<string, unknown>,
        idResult = externalIdSchema.safeParse(fields.externalId);
      if (!idResult.success) {
        issue(`row:${i + 1}`, "Missing or invalid externalId");
        continue;
      }
      const externalId = idResult.data;
      if (seen.has(externalId)) {
        issue(externalId, "Repeated externalId in the same delivery");
        continue;
      }
      seen.add(externalId);
      if (Object.keys(fields).some((key) => !allowed.has(key))) {
        issue(externalId, "Contact contains unsupported fields");
        continue;
      }
      const parsed = normalizeContact(fields);
      if (!parsed.contact) {
        issue(externalId, parsed.errors.join("; "));
        continue;
      }
      const contact = { ...parsed.contact, source: input.source };
      const link = await tx.query<{ client_id: string }>(
        "SELECT client_id FROM client_external_sources WHERE connection_id=$1 AND external_id=$2",
        [input.connectionId, externalId],
      );
      let current: ClientRow | undefined;
      if (link.rows[0])
        current = await requireClient(tx, link.rows[0].client_id);
      else if (contact.email) {
        const matches = await contactsByEmails(tx, [
            normalizeEmail(contact.email),
          ]),
          found = matches.get(normalizeEmail(contact.email)) ?? [];
        if (found.length > 1) {
          issue(
            externalId,
            "Email matches multiple CRM contacts; resolve the duplicates",
          );
          continue;
        }
        current = found[0];
      }
      let clientId: string;
      if (current) {
        const patch = blankPatch(current, contact);
        // An established external link wins over email rematching, while filling
        // an empty local email must still avoid introducing another duplicate.
        if (patch.email) {
          const matches = await contactsByEmails(tx, [
            normalizeEmail(patch.email),
          ]);
          if (
            (matches.get(normalizeEmail(patch.email)) ?? []).some(
              (c) => c.id !== current!.id,
            )
          ) {
            issue(
              externalId,
              "Incoming email belongs to a different CRM contact",
            );
            continue;
          }
        }
        clientId = current.id;
        if (Object.keys(patch).length) {
          await updateContact(
            tx,
            event.businessId,
            clientId,
            patch,
            event.correlationId,
            false,
          );
          result.updated++;
        } else result.skipped++;
      } else {
        if (
          !contact.displayName &&
          ![contact.firstName, contact.lastName].filter(Boolean).join(" ")
        ) {
          issue(
            externalId,
            "New source contact requires a display name or first/last name",
          );
          continue;
        }
        if (
          !contact.displayName &&
          [contact.firstName, contact.lastName].filter(Boolean).join(" ")
            .length > 160
        ) {
          issue(externalId, "Combined name exceeds 160 characters");
          continue;
        }
        const created = await createContact(
          tx,
          event.businessId,
          { ...contact, kind: "student" } as ContactInput,
          event.correlationId,
        );
        clientId = created.id;
        result.created++;
      }
      await tx.query(
        `INSERT INTO client_external_sources(business_id,connection_id,external_id,client_id,source)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_id,connection_id,external_id)
        DO UPDATE SET source=EXCLUDED.source,last_seen_at=now()`,
        [
          event.businessId,
          input.connectionId,
          externalId,
          clientId,
          input.source,
        ],
      );
    }
    await emitEvent(tx, {
      type: "clients.source-synced.v1",
      producer: "clients",
      businessId: event.businessId,
      correlationId: event.correlationId,
      data: result,
    });
  }
}
