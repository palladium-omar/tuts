import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createClientSchema,
  listClientsSchema,
  updateClientSchema,
} from "../src/schemas.js";
import { ClientsController } from "../src/clients.controller.js";
import type { Database } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";

const tenant = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";
const payer = "33333333-3333-4333-8333-333333333333";
const context: RequestContext = {
  businessId: tenant,
  sub: "staff-a",
  role: "owner",
  entitlements: ["clients"],
  requestId: "44444444-4444-4444-8444-444444444444",
};
const row = {
  id: client,
  kind: "student",
  display_name: "Synthetic Student",
  email: null,
  phone: null,
  notes: null,
  created_at: new Date(),
  updated_at: new Date(),
};

test("client validation is bounded and rejects tenant override/kind changes", () => {
  assert.equal(
    createClientSchema.safeParse({ displayName: "Student", businessId: tenant })
      .success,
    false,
  );
  assert.equal(
    createClientSchema.safeParse({
      displayName: "Student",
      email: "not-an-email",
    }).success,
    false,
  );
  assert.equal(updateClientSchema.safeParse({ kind: "payer" }).success, false);
  assert.equal(updateClientSchema.safeParse({}).success, false);
  assert.equal(listClientsSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(listClientsSchema.parse({}).limit, 50);
});
test("create runs insert and non-PII event on the same selected tenant transaction", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const db = {
    async withTenant(id: string, work: (tx: unknown) => Promise<unknown>) {
      assert.equal(id, tenant);
      return work({
        async query(sql: string, values: unknown[]) {
          queries.push({ sql, values });
          return { rows: sql.startsWith('INSERT INTO clients') ? [row] : [] };
        },
      });
    },
  } as unknown as Database;
  const result = await new ClientsController(db).create(context, {
    displayName: "Synthetic Student",
  });
  assert.equal(result.item.displayName, "Synthetic Student");
  assert.ok(queries[0]!.sql.includes("pg_advisory_xact_lock"));
  assert.ok(queries[1]!.sql.startsWith("INSERT INTO clients"));
  assert.equal(queries[1]!.values[0], tenant);
  const outbox = queries.find(query => query.sql.startsWith('INSERT INTO service_outbox'))!;
  assert.ok(outbox, 'create must persist its event inside the same tenant callback');
  const event = JSON.parse(outbox.values[1] as string);
  assert.equal(event.businessId, tenant);
  assert.equal(event.type, "clients.client-created.v1");
  assert.deepEqual(event.data, {
    clientId: queries[1]!.values[1],
    emailOptIn: false,
    whatsappOptIn: false,
  });
});
test("an outbox failure rejects the business mutation transaction callback", async () => {
  let rolledBack = false;
  const db = {
    async withTenant(_id: string, work: (tx: unknown) => Promise<unknown>) {
      try {
        return await work({
          query: async (sql: string) => {
            if (sql.includes("service_outbox"))
              throw new Error("outbox unavailable");
            return { rows: [row] };
          },
        });
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  } as unknown as Database;
  await assert.rejects(
    new ClientsController(db).create(context, {
      displayName: "Synthetic Student",
    }),
    /outbox unavailable/,
  );
  assert.equal(rolledBack, true);
});
test("unrelated tenant client is absent and returns 404", async () => {
  const db = {
    async withTenant(id: string, work: (tx: unknown) => Promise<unknown>) {
      assert.equal(id, tenant);
      return work({ query: async () => ({ rows: [] }) });
    },
  } as unknown as Database;
  await assert.rejects(
    new ClientsController(db).get(context, client),
    /Client was not found/,
  );
});
test("payer linkage rejects student-as-payer and writes no relationship", async () => {
  let writes = 0;
  const db = {
    async withTenant(_id: string, work: (tx: unknown) => Promise<unknown>) {
      return work({
        query: async (sql: string, values: string[]) => {
          if (sql.startsWith("INSERT")) writes++;
          return { rows: [{ ...row, id: values[0] }] };
        },
      });
    },
  } as unknown as Database;
  await assert.rejects(
    new ClientsController(db).linkPayer(context, client, { payerId: payer }),
    /separate payer/,
  );
  assert.equal(writes, 0);
});
