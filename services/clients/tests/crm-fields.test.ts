import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { Database } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import { buildClientQuery } from "../src/client-query.js";
import {
  validateCustomFields,
  validateCustomValue,
  type FieldRow,
} from "../src/custom-fields.js";
import {
  createClientSchema,
  listClientsSchema,
  recipientRequestSchema,
  importRequestSchema,
} from "../src/schemas.js";
import { updateContact } from "../src/contact-store.js";
import { previewImport } from "../src/imports.js";
import { RecipientsController } from "../src/recipients.controller.js";
import { FieldsController } from "../src/fields.controller.js";

const fieldId = "55555555-5555-4555-8555-555555555555";
const otherId = "66666666-6666-4666-8666-666666666666";
const clientId = "77777777-7777-4777-8777-777777777777";
const ctx: RequestContext = {
  businessId: "11111111-1111-4111-8111-111111111111",
  sub: "synthetic-owner",
  role: "owner",
  entitlements: ["clients"],
  requestId: "synthetic-request",
};
const definition: FieldRow = {
  id: fieldId,
  key: "score",
  label: "Score",
  type: "number",
  options: null,
  created_at: new Date(),
};
const tx = (query: (sql: string, values?: unknown[]) => Promise<unknown>) =>
  ({ query }) as unknown as PoolClient;

test("custom values use tenant definitions and reject absent fields/types/invalid dates", async () => {
  const connection = tx(async () => ({ rows: [definition] }));
  await validateCustomFields(connection, { [fieldId]: 4 });
  await validateCustomFields(connection, { [fieldId]: null });
  await assert.rejects(
    validateCustomFields(connection, { [otherId]: "private" }),
    /Unknown CRM field/,
  );
  await assert.rejects(
    validateCustomFields(connection, { [fieldId]: "4" }),
    /Invalid value/,
  );
  assert.throws(
    () => validateCustomValue({ ...definition, type: "date" }, "2026-02-30"),
    /Invalid value/,
  );
  assert.throws(
    () =>
      validateCustomValue(
        { ...definition, type: "select", options: ["A"] },
        "B",
      ),
    /Invalid value/,
  );
  assert.equal(
    createClientSchema.safeParse({
      displayName: "Synthetic",
      emailOptIn: "true",
    }).success,
    false,
  );
});

test("filters parameterize custom keys and values; sort bindings are omitted from count", async () => {
  const query = await buildClientQuery(
    tx(async () => ({ rows: [definition] })),
    listClientsSchema.parse({
      search: "x%' OR 1=1 --",
      tag: "A",
      filters: JSON.stringify([
        { field: `custom:${fieldId}`, operator: "gt", value: 4 },
      ]),
      sortBy: `custom:${fieldId}`,
    }),
  );
  assert.ok(!query.where.includes(fieldId));
  assert.ok(!query.where.includes("OR 1=1"));
  assert.ok(query.where.includes("::numeric"));
  assert.ok(query.values.includes(fieldId));
  assert.equal(query.values.length, query.countValues.length + 1);
  assert.ok(
    query.values.some((v) => typeof v === "string" && v.includes("\\%")),
  );
  await assert.rejects(
    buildClientQuery(
      tx(async () => ({ rows: [definition] })),
      listClientsSchema.parse({
        filters: [
          { field: `custom:${fieldId}`, operator: "contains", value: "4" },
        ],
      }),
    ),
    /requires a text/,
  );
  await assert.rejects(
    buildClientQuery(
      tx(async () => ({ rows: [] })),
      listClientsSchema.parse({
        filters: [
          { field: "businessId", operator: "equals", value: ctx.businessId },
        ],
      }),
    ),
    /Unsupported filter/,
  );
});

test("recipient selection is mutually exclusive, bounded and rejects pagination", () => {
  assert.equal(recipientRequestSchema.safeParse({}).success, false);
  assert.equal(
    recipientRequestSchema.safeParse({ clientIds: [clientId], filter: {} })
      .success,
    false,
  );
  assert.equal(
    recipientRequestSchema.safeParse({ filter: { limit: 100 } }).success,
    false,
  );
  assert.equal(
    recipientRequestSchema.safeParse({
      clientIds: Array.from({ length: 2001 }, () => clientId),
    }).success,
    false,
  );
  assert.equal(
    listClientsSchema.safeParse({ filters: "invalid json" }).success,
    false,
  );
});

test("partial custom patch merges values and emits current consent within transaction", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  await updateContact(
    tx(async (sql, values = []) => {
      queries.push({ sql, values });
      return {
        rows: sql.includes("client_fields") ? [definition]
          : sql.startsWith('WITH RECURSIVE canonical') || sql.includes('RETURNING *') ? [{
            id: clientId, kind: 'student', display_name: 'Synthetic Student',
            email: null, phone: null, revision: 1, merged_into: null,
            email_opt_in: true, whatsapp_opt_in: false
          }] : [],
      };
    }),
    ctx.businessId,
    clientId,
    { customFields: { [fieldId]: null } },
  );
  const update = queries.find((q) => q.sql.startsWith("UPDATE clients"))!;
  assert.ok(update.sql.includes("custom_fields=custom_fields ||"));
  assert.deepEqual(JSON.parse(update.values[1] as string), { [fieldId]: null });
  const outbox = queries.find((q) =>
    q.sql.startsWith("INSERT INTO service_outbox"),
  )!;
  assert.deepEqual(JSON.parse(outbox.values[1] as string).data, {
    clientId,
    emailOptIn: true,
    whatsappOptIn: false,
  });
});

test("import preview converts mapped custom and consent columns and reports typed errors", async () => {
  const input = importRequestSchema.parse({
    rows: [
      {
        Name: "Synthetic",
        Email: "synthetic@example.test",
        Score: "12",
        Consent: "no",
      },
      {
        Name: "Invalid",
        Email: "invalid@example.test",
        Score: "oops",
        Consent: "yes",
      },
    ],
    mapping: {
      displayName: "Name",
      email: "Email",
      [`custom:${fieldId}`]: "Score",
      emailOptIn: "Consent",
    },
  });
  const preview = await previewImport(
    tx(async (sql) => ({
      rows: sql.includes("client_fields") ? [definition] : [],
    })),
    input,
  );
  assert.equal(preview.rows[0]!.action, "create");
  assert.equal(preview.rows[0]!.contact!.emailOptIn, false);
  assert.deepEqual(preview.rows[0]!.contact!.customFields, { [fieldId]: 12 });
  assert.equal(preview.rows[1]!.action, "error");
});

test("recipient resolver tenant-scopes HTTP requests and reports truncation with consent", async () => {
  const db = {
    withTenant: async (
      businessId: string,
      work: (connection: PoolClient) => Promise<unknown>,
    ) => {
      assert.equal(businessId, ctx.businessId);
      return work(
        tx(async (sql) => ({
          rows: sql.includes("count(*)")
            ? [{ total: "2001" }]
            : sql.includes("client_fields")
              ? []
              : [
                  {
                    id: clientId,
                    display_name: "Synthetic",
                    email_opt_in: true,
                    whatsapp_opt_in: false,
                    custom_fields: {},
                  },
                ],
        })),
      );
    },
  } as unknown as Database;
  const result = await new RecipientsController(db).resolve(ctx, {
    filter: {},
  });
  assert.equal(result.total, 2001);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0]!.emailOptIn, true);
});

test("select field update refuses options that existing contacts use", async () => {
  const db = {
    withTenant: async (
      _: string,
      work: (connection: PoolClient) => Promise<unknown>,
    ) =>
      work(
        tx(async (sql) => ({
          rows: sql.includes("client_fields")
            ? [{ ...definition, type: "select", options: ["A", "B"] }]
            : [],
          rowCount: sql.startsWith("SELECT 1 FROM clients") ? 1 : 0,
        })),
      ),
  } as unknown as Database;
  await assert.rejects(
    new FieldsController(db).update(ctx, fieldId, { options: ["A"] }),
    /cannot be removed/,
  );
});
