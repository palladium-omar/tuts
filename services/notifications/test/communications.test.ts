import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database, EventBus } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import {
  CampaignsController,
  CommunicationConnectionsController,
  CommunicationsService,
  connectionView,
  requireManager,
  resolveRecipients,
} from "../src/communications.js";
import {
  campaignSchema,
  connectionSchema,
  eligibility,
  personalize,
} from "../src/communication-schemas.js";
import {
  decryptCredentials,
  deliveryEnabled,
  encryptCredentials,
  httpsEndpoint,
  publicIp,
  safeJsonPost,
} from "../src/communication-security.js";
import { deliver, whatsappPayload } from "../src/communication-providers.js";
import {
  applyConsent,
  CommunicationWorker,
} from "../src/communication-worker.js";
const ctx: RequestContext = {
  businessId: randomUUID(),
  sub: "synthetic-staff",
  role: "owner",
  entitlements: ["notifications", "clients"],
  requestId: randomUUID(),
};
const contact = {
  id: randomUUID(),
  displayName: "Demo Client",
  firstName: "Demo",
  lastName: "Client",
  email: "demo@example.invalid",
  phone: "+15555550123",
  emailOptIn: true,
  whatsappOptIn: false,
  customFields: {},
};
test("configuration requires TLS SMTP, opaque tenant fields are rejected, and WhatsApp has no free text campaign path", () => {
  assert.equal(
    connectionSchema.safeParse({
      provider: "smtp",
      displayName: "Mailbox",
      config: {
        host: "smtp.example.invalid",
        port: 25,
        fromEmail: "staff@example.invalid",
      },
      credentials: { username: "staff", password: "test" },
    }).success,
    false,
  );
  const base = {
    connectionId: randomUUID(),
    channel: "email",
    selection: { clientIds: [contact.id] },
    subject: "Hello",
    message: "Body",
  };
  assert.equal(
    campaignSchema.safeParse({ ...base, businessId: randomUUID() }).success,
    false,
  );
  assert.equal(
    campaignSchema.safeParse({
      ...base,
      recipients: [{ email: "untrusted@example.invalid" }],
    }).success,
    false,
  );
  assert.equal(
    campaignSchema.safeParse({ ...base, channel: "whatsapp" }).success,
    false,
  );
  assert.equal(
    campaignSchema.safeParse({
      connectionId: base.connectionId,
      channel: "whatsapp",
      selection: {},
      template: {
        name: "welcome",
        language: "en_US",
        parameters: ["{{firstName}}"],
      },
    }).success,
    true,
  );
  const payload = whatsappPayload({
    id: randomUUID(),
    address: "+15555550123",
    subject: "",
    message: "",
    template: { name: "welcome", language: "en_US", parameters: ["Demo"] },
  });
  assert.equal(payload.type, "template");
  assert.equal(payload.template.components?.[0]?.parameters[0]?.text, "Demo");
});
test("personalization is bounded literal substitution and contacts require channel consent", () => {
  const field = randomUUID();
  assert.equal(
    personalize(`Hi {{firstName}} {{custom:${field}}}`, {
      ...contact,
      customFields: { [field]: "Value" },
    }),
    "Hi Demo Value",
  );
  assert.throws(() => personalize("{{process.env.TOKEN}}", contact));
  assert.throws(() => personalize("{{firstName", contact));
  assert.equal(eligibility(contact, "whatsapp").reason, "consent_required");
  assert.equal(
    eligibility({ ...contact, emailOptIn: false }, "email").reason,
    "consent_required",
  );
  assert.equal(
    eligibility({ ...contact, email: "invalid" }, "email").reason,
    "invalid_address",
  );
  assert.equal(
    eligibility(
      { ...contact, whatsappOptIn: true, phone: "555-0123" },
      "whatsapp",
    ).reason,
    "invalid_address",
  );
});
test("AES authenticated encryption is tenant bound and views never reveal stored credentials", () => {
  const previous = process.env.COMMUNICATIONS_ENCRYPTION_KEY;
  process.env.COMMUNICATIONS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  try {
    const encrypted = encryptCredentials(
      { apiKey: "synthetic-secret" },
      ctx.businessId,
    );
    assert.equal(encrypted.includes("synthetic-secret"), false);
    assert.deepEqual(decryptCredentials(encrypted, ctx.businessId), {
      apiKey: "synthetic-secret",
    });
    assert.throws(() => decryptCredentials(encrypted, randomUUID()));
    const row = {
      id: randomUUID(),
      business_id: ctx.businessId,
      provider: "resend",
      display_name: "Demo",
      config: { fromEmail: "staff@example.invalid" },
      credentials_encrypted: encrypted,
      status: "active",
      revision: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
    assert.equal(
      JSON.stringify(connectionView(row)).includes(encrypted),
      false,
    );
    assert.equal(connectionView(row).verificationStatus, "not_verified");
  } finally {
    if (previous === undefined)
      delete process.env.COMMUNICATIONS_ENCRYPTION_KEY;
    else process.env.COMMUNICATIONS_ENCRYPTION_KEY = previous;
  }
});
test("HTTPS providers reject local, metadata, reserved and mapped addresses before external I/O", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(publicIp(ip), false, ip);
  assert.equal(publicIp("8.8.8.8"), true);
  assert.equal(publicIp("2606:4700:4700::1111"), true);
  for (const url of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com:8443",
    "https://example.com/#fragment",
  ])
    assert.throws(() => httpsEndpoint(url));
  await assert.rejects(
    safeJsonPost("https://127.0.0.1", { test: true }),
    /public addresses/,
  );
  await assert.rejects(
    safeJsonPost("https://169.254.169.254", { test: true }),
    /public addresses/,
  );
});
test("all real adapters refuse delivery without the explicit outbound flag, before DNS or transport", async () => {
  const previous = process.env.ALLOW_OUTBOUND_DELIVERY;
  delete process.env.ALLOW_OUTBOUND_DELIVERY;
  try {
    assert.equal(deliveryEnabled(), false);
    for (const provider of ["smtp", "resend", "whatsapp_business"])
      await assert.rejects(
        deliver(
          { provider, config: { host: "localhost" }, credentials: {} },
          {
            id: randomUUID(),
            address: "demo@example.invalid",
            subject: "Demo",
            message: "Demo",
            template: null,
          },
        ),
        /disabled/,
      );
  } finally {
    if (previous !== undefined) process.env.ALLOW_OUTBOUND_DELIVERY = previous;
  }
});
test("connection mutations and campaign approval are restricted to owners/admins", () => {
  assert.throws(() => requireManager({ ...ctx, role: "tutor" }), {
    status: 403,
  });
  assert.throws(() => requireManager({ ...ctx, role: "parent" }), {
    status: 403,
  });
  requireManager({ ...ctx, role: "admin" });
  for (const method of ["create", "patch", "disable"] as const)
    assert.deepEqual(
      Reflect.getMetadata(
        "palladium.roles",
        CommunicationConnectionsController.prototype[method],
      ),
      ["owner", "admin"],
    );
  for (const method of ["create", "send", "cancel"] as const)
    assert.deepEqual(
      Reflect.getMetadata(
        "palladium.roles",
        CampaignsController.prototype[method],
      ),
      ["owner", "admin"],
    );
});
test("recipient lookup forwards signed caller context and rejects truncated CRM selection", async () => {
  const previousUrl = process.env.CLIENTS_URL,
    originalFetch = global.fetch;
  process.env.CLIENTS_URL = "http://127.0.0.1:4002";
  let forwarded = "";
  try {
    global.fetch = (async (_input, options) => {
      forwarded = (options?.headers as Record<string, string>).Authorization;
      return new Response(
        JSON.stringify({ items: [contact], total: 1, truncated: false }),
        { status: 200 },
      );
    }) as typeof fetch;
    assert.equal(
      (
        await resolveRecipients(
          { clientIds: [contact.id] },
          "Bearer signed-short-lived-context",
        )
      )[0]?.id,
      contact.id,
    );
    assert.equal(forwarded, "Bearer signed-short-lived-context");
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ items: [], total: 2001, truncated: true }),
        { status: 200 },
      )) as typeof fetch;
    await assert.rejects(resolveRecipients({}, "Bearer test"), { status: 400 });
  } finally {
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.CLIENTS_URL;
    else process.env.CLIENTS_URL = previousUrl;
  }
});
test(
  "PostgreSQL campaigns isolate tenants, snapshot CRM contacts, require approval, dedup queue, preserve acceptance and recover unknown leases",
  { skip: !process.env.NOTIFICATIONS_TEST_DATABASE_URL },
  async () => {
    const previousUrl = process.env.DATABASE_URL,
      previousKey = process.env.COMMUNICATIONS_ENCRYPTION_KEY,
      previousOutbound = process.env.ALLOW_OUTBOUND_DELIVERY,
      previousClients = process.env.CLIENTS_URL,
      originalFetch = global.fetch;
    process.env.DATABASE_URL = process.env.NOTIFICATIONS_TEST_DATABASE_URL;
    process.env.COMMUNICATIONS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.CLIENTS_URL = "http://127.0.0.1:4002";
    delete process.env.ALLOW_OUTBOUND_DELIVERY;
    const db = new Database(),
      service = new CommunicationsService(db),
      other = { ...ctx, businessId: randomUUID() };
    try {
      const role = (
        await db.pool.query(
          "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
      await db.migrate(
        fileURLToPath(new URL("../migrations", import.meta.url)),
      );
      const connection = await service.createConnection(ctx, {
        provider: "resend",
        displayName: "Synthetic sender",
        config: { fromEmail: "staff@example.invalid" },
        credentials: { apiKey: "synthetic-never-sent" },
      });
      assert.equal(connection.deliveryEnabled, false);
      assert.equal((await service.listConnections(other)).items.length, 0);
      const optedOut = {
        ...contact,
        id: randomUUID(),
        email: "optout@example.invalid",
        emailOptIn: false,
      };
      const duplicate = { ...contact, id: randomUUID() };
      global.fetch = (async () =>
        new Response(
          JSON.stringify({
            items: [contact, optedOut, duplicate],
            total: 3,
            truncated: false,
          }),
          { status: 200 },
        )) as typeof fetch;
      const draft = await service.createCampaign(
        ctx,
        {
          connectionId: connection.item.id,
          channel: "email",
          selection: { clientIds: [contact.id, optedOut.id, duplicate.id] },
          subject: "Hello {{firstName}}",
          message: "Private individual greeting to {{displayName}}",
        },
        "Bearer synthetic",
      );
      assert.equal(draft.item.counts.pending, 1);
      assert.equal(draft.item.counts.skipped, 2);
      assert.equal(
        draft.recipients.find((r) => r.clientId === contact.id)?.subject,
        "Hello Demo",
      );
      assert.equal((await service.listCampaigns(other)).items.length, 0);
      await assert.rejects(service.getCampaign(other, draft.item.id), {
        status: 404,
      });
      assert.equal(
        (
          await db.pool.query(
            "SELECT * FROM communication_campaigns WHERE id=$1",
            [draft.item.id],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        service.sendCampaign(ctx, draft.item.id, {
          confirmationToken: draft.item.confirmationToken,
        }),
        { status: 409 },
      );
      process.env.ALLOW_OUTBOUND_DELIVERY = "true";
      await assert.rejects(
        service.sendCampaign(ctx, draft.item.id, {
          confirmationToken: "a".repeat(64),
        }),
        { status: 409 },
      );
      const results = await Promise.all([
        service.sendCampaign(ctx, draft.item.id, {
          confirmationToken: draft.item.confirmationToken,
        }),
        service.sendCampaign(ctx, draft.item.id, {
          confirmationToken: draft.item.confirmationToken,
        }),
      ]);
      assert.ok(results.every((r) => r.item.status === "queued"));
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS count FROM service_outbox WHERE event->>'type'='notifications.campaign-queued.v1' AND event->'data'->>'campaignId'=$1",
            [draft.item.id],
          )
        ).rows[0].count,
        1,
      );
      delete process.env.ALLOW_OUTBOUND_DELIVERY; // No worker/provider I/O is enabled in this test.
      await db.withTenant(ctx.businessId, async (tx) => {
        await tx.query(
          "UPDATE communication_recipients SET status='sending',lease_token=$3,lease_until=now()-interval '1 minute' WHERE business_id=$1 AND campaign_id=$2 AND status='pending'",
          [ctx.businessId, draft.item.id, randomUUID()],
        );
      });
      await new CommunicationWorker(db, {
        subscribe: () => {},
      } as unknown as EventBus).processTenant(ctx.businessId);
      const recovered = await service.getCampaign(ctx, draft.item.id);
      assert.equal(recovered.item.counts.unknown, 1);
      assert.equal(recovered.item.status, "completed");
      global.fetch = (async () =>
        new Response(
          JSON.stringify({
            items: [
              contact,
              { ...contact, id: randomUUID(), email: "other@example.invalid" },
            ],
            total: 2,
            truncated: false,
          }),
          { status: 200 },
        )) as typeof fetch;
      const next = await service.createCampaign(
        ctx,
        {
          connectionId: connection.item.id,
          channel: "email",
          selection: {},
          subject: "Demo",
          message: "Draft",
        },
        "Bearer synthetic",
      );
      await db.withTenant(ctx.businessId, async (tx) => {
        await tx.query(
          "UPDATE communication_recipients SET status='accepted',provider_message_id='provider-fixture',accepted_at=now() WHERE business_id=$1 AND campaign_id=$2 AND client_id=$3",
          [ctx.businessId, next.item.id, contact.id],
        );
        await applyConsent(
          {
            businessId: ctx.businessId,
            occurredAt: new Date().toISOString(),
            data: { clientId: contact.id, emailOptIn: false },
          },
          tx,
        );
      });
      const pending = next.recipients.find((r) => r.clientId !== contact.id)!;
      await db.withTenant(ctx.businessId, (tx) =>
        applyConsent(
          {
            businessId: ctx.businessId,
            occurredAt: new Date().toISOString(),
            data: { clientId: pending.clientId, emailOptIn: false },
          },
          tx,
        ),
      );
      const revoked = await service.getCampaign(ctx, next.item.id);
      assert.equal(
        revoked.recipients.find((r) => r.clientId === pending.clientId)?.reason,
        "consent_revoked",
      );
      assert.notEqual(
        revoked.item.confirmationToken,
        next.item.confirmationToken,
      );
      await db.withTenant(ctx.businessId, (tx) =>
        applyConsent(
          {
            businessId: ctx.businessId,
            occurredAt: "2000-01-01T00:00:00.000Z",
            data: { clientId: pending.clientId, emailOptIn: true },
          },
          tx,
        ),
      );
      assert.equal(
        (await service.getCampaign(ctx, next.item.id)).recipients.find(
          (r) => r.clientId === pending.clientId,
        )?.reason,
        "consent_revoked",
      );
      await service.cancelCampaign(ctx, next.item.id);
      const cancelled = await service.getCampaign(ctx, next.item.id);
      assert.equal(cancelled.item.counts.accepted, 1);
      assert.equal(cancelled.item.counts.skipped, 1);
      assert.equal(
        cancelled.recipients.find((r) => r.clientId === contact.id)
          ?.providerMessageId,
        "provider-fixture",
      );
      await service.disableConnection(ctx, connection.item.id);
      assert.equal(
        (await service.listConnections(ctx)).items[0]?.status,
        "disabled",
      );
    } finally {
      await db.withTenant(ctx.businessId, async (tx) => {
        await tx.query(
          "DELETE FROM communication_recipients WHERE business_id=$1",
          [ctx.businessId],
        );
        await tx.query(
          "DELETE FROM communication_campaigns WHERE business_id=$1",
          [ctx.businessId],
        );
        await tx.query(
          "DELETE FROM communication_connections WHERE business_id=$1",
          [ctx.businessId],
        );
        await tx.query(
          "DELETE FROM communication_consent WHERE business_id=$1",
          [ctx.businessId],
        );
        await tx.query(
          "DELETE FROM service_outbox WHERE event->>'businessId'=$1",
          [ctx.businessId],
        );
      });
      await db.pool.end();
      global.fetch = originalFetch;
      for (const [name, value] of [
        ["DATABASE_URL", previousUrl],
        ["COMMUNICATIONS_ENCRYPTION_KEY", previousKey],
        ["ALLOW_OUTBOUND_DELIVERY", previousOutbound],
        ["CLIENTS_URL", previousClients],
      ]) {
        if (value === undefined) delete process.env[name!];
        else process.env[name!] = value;
      }
    }
  },
);
