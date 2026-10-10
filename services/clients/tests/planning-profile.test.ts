import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { Database } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import { createClientSchema, updateClientSchema } from "../src/schemas.js";
import { planningProfileSchema, studentPlanningProfile } from "../src/planning-profile.js";
import { createContact, item, updateContact, type ClientRow } from "../src/contact-store.js";
import { PortalStudentsController } from "../src/portal-students.controller.js";
import { commitMerge, mergePreview } from "../src/student-identity.js";

const businessId = "11111111-1111-4111-8111-111111111111", studentId = "22222222-2222-4222-8222-222222222222", otherId = "33333333-3333-4333-8333-333333333333";
const ctx: RequestContext = { businessId, sub: "synthetic-tutor", role: "tutor", entitlements: ["clients"], requestId: "synthetic-profile" };
const profile = { currentGrade: 11, academicYear: 2026, graduationYear: 2028, entryCycle: 2029, applicantCountry: "MA", templateKey: "common-app-2029" };
const row = { id: studentId, kind: "student", revision: 1, display_name: "Synthetic Student", first_name: "Synthetic", last_name: "Student", email: null, phone: null, notes: "private note", tags: [], custom_fields: {}, planning_profile: profile } as unknown as ClientRow;
const tx = (query: (sql: string, values: unknown[]) => Promise<unknown>) => ({ query }) as unknown as PoolClient;

test("create and update accept a strict bounded profile and reject private or inconsistent facts", () => {
  assert.deepEqual(createClientSchema.parse({ displayName: "Synthetic Student", planningProfile: profile }).planningProfile, profile);
  assert.deepEqual(updateClientSchema.parse({ planningProfile: profile }).planningProfile, profile);
  assert.equal(updateClientSchema.parse({ planningProfile: null }).planningProfile, null);
  for (const value of [{}, { currentGrade: 8 }, { currentGrade: "11" }, { academicYear: 2026.5 }, { graduationYear: 2201 }, { currentGrade: 11, academicYear: 2026, graduationYear: 2027 }, { currentGrade: 11, academicYear: 2026, entryCycle: 2027 }, { ...profile, notes: "private" }, { ...profile, applicantCountry: "morocco" }]) assert.equal(planningProfileSchema.safeParse(value).success, false);
  assert.equal(createClientSchema.safeParse({ kind: "payer", displayName: "Payer", planningProfile: profile }).success, false);
});

test("profile create persists JSON in the selected tenant transaction with an outbox event", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const saved = await createContact(tx(async (sql, values = []) => { queries.push({ sql, values }); return { rows: sql.startsWith("INSERT INTO clients") ? [row] : [] }; }), businessId, createClientSchema.parse({ displayName: row.display_name, planningProfile: profile }));
  const insert = queries.find(query => query.sql.startsWith("INSERT INTO clients"))!;
  assert.match(insert.sql, /planning_profile/); assert.equal(insert.values[0], businessId); assert.deepEqual(JSON.parse(insert.values[16] as string), profile);
  assert.deepEqual(item(saved).planningProfile, profile);
  assert.ok(queries.some(query => query.sql.startsWith("INSERT INTO service_outbox")));
});

test("profile PATCH replaces validated education facts, supports clear, and rejects a payer", async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const connection = tx(async (sql, values = []) => { queries.push({ sql, values }); return { rows: sql.startsWith("WITH RECURSIVE") || sql.includes("RETURNING *") ? [row] : [] }; });
  await updateContact(connection, businessId, studentId, { planningProfile: { graduationYear: 2030 } });
  const update = queries.find(query => query.sql.startsWith("UPDATE clients SET planning_profile"))!;
  assert.match(update.sql, /planning_profile=\$2::jsonb/); assert.deepEqual(JSON.parse(update.values[1] as string), { graduationYear: 2030 });
  assert.ok(queries.some(query => query.sql.startsWith("INSERT INTO service_outbox")));
  queries.length = 0;
  await updateContact(connection, businessId, studentId, { planningProfile: null });
  assert.equal(queries.find(query => query.sql.startsWith("UPDATE clients SET planning_profile"))!.values[1], null);
  await assert.rejects(updateContact(tx(async () => ({ rows: [{ ...row, kind: "payer" }] })), businessId, studentId, { planningProfile: profile }), /belong to students/);
});

test("student-safe profile includes only approved education keys", () => {
  assert.deepEqual(studentPlanningProfile(profile), { currentGrade: 11, academicYear: 2026, graduationYear: 2028, entryCycle: 2029 });
  assert.equal(studentPlanningProfile({ ...profile, privateNotes: "secret" }), null);
  assert.equal(studentPlanningProfile(null), null);
});

test("portal reads scope the student and never expose CRM notes or applicability metadata", async () => {
  const db = { async withTenant(tenant: string, work: (connection: PoolClient) => Promise<unknown>) { assert.equal(tenant, businessId); return work(tx(async sql => ({ rows: sql.startsWith("WITH RECURSIVE") ? [row] : [] }))); } } as unknown as Database;
  const scoped: RequestContext = { ...ctx, role: "student", accessScope: "students", studentIds: [studentId] };
  const result = await new PortalStudentsController(db).get(scoped, studentId);
  assert.deepEqual(result.item.planningProfile, { currentGrade: 11, academicYear: 2026, graduationYear: 2028, entryCycle: 2029 });
  assert.equal("notes" in result.item, false); assert.equal("customFields" in result.item, false);
  await assert.rejects(new PortalStudentsController(db).get(scoped, otherId));
});

test("a merge reviews conflicting whole education profiles before writing", async () => {
  let writes = 0;
  const connection = tx(async (sql, values = []) => {
    if (/^(UPDATE|INSERT|DELETE)/.test(sql)) writes++;
    return { rows: sql.startsWith("WITH RECURSIVE") ? [{ ...row, id: values[0], planning_profile: values[0] === studentId ? profile : { graduationYear: 2031 } }] : sql.startsWith("SELECT (SELECT count(*)") ? [{ contacts: "0", payers: "0", source_identities: "0", groups: "0" }] : [] };
  });
  const preview = await mergePreview(connection, studentId, otherId);
  assert.equal(preview.conflicts.find(conflict => conflict.field === "planningProfile")?.source, profile);
  await assert.rejects(commitMerge(connection, ctx, { sourceId: studentId, targetId: otherId, sourceRevision: 1, targetRevision: 1, fieldChoices: {} }), /every conflict/);
  assert.equal(writes, 0);
});

test("equivalent education profiles in different JSON key order do not create a merge conflict", async () => {
  const reversed = Object.fromEntries(Object.entries(profile).reverse());
  const preview = await mergePreview(tx(async (sql, values = []) => ({ rows: sql.startsWith("WITH RECURSIVE") ? [{ ...row, id: values[0], planning_profile: values[0] === studentId ? profile : reversed }] : sql.startsWith("SELECT (SELECT count(*)") ? [{ contacts: "0", payers: "0", source_identities: "0", groups: "0" }] : [] })), studentId, otherId);
  assert.equal(preview.conflicts.some(conflict => conflict.field === "planningProfile"), false);
});

test("merge preserves the target's reviewed profile and recovers a source profile only into an empty target", async () => {
  for (const targetProfile of [{ graduationYear: 2031 }, null]) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const connection = tx(async (sql, values = []) => {
      queries.push({ sql, values });
      return { rows: sql.startsWith("WITH RECURSIVE") ? [{ ...row, id: values[0], planning_profile: values[0] === studentId ? profile : targetProfile }]
        : sql.startsWith("SELECT (SELECT count(*)") ? [{ contacts: "0", payers: "0", source_identities: "0", groups: "0" }]
        : sql.startsWith("SELECT count(DISTINCT contact_id)") ? [{ count: "0" }]
        : sql.startsWith("UPDATE clients SET") && sql.includes("planning_profile=") ? [{ ...row, id: otherId, revision: 2, planning_profile: targetProfile ?? profile }]
        : [] };
    });
    await commitMerge(connection, ctx, { sourceId: studentId, targetId: otherId, sourceRevision: 1, targetRevision: 1, fieldChoices: targetProfile ? { planningProfile: "target" } : {} });
    const update = queries.find(query => query.sql.startsWith("UPDATE clients SET") && query.sql.includes("planning_profile="))!;
    const binding = Number(update.sql.match(/planning_profile=\$(\d+)/)![1]);
    assert.deepEqual(JSON.parse(update.values[binding - 1] as string), targetProfile ?? profile);
  }
});
