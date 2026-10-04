import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database, EventBus } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import {
  StripeClient,
  StripeError,
  checkoutPayload,
  requireStripeTest,
  stripeCredentialsSchema,
  validateStripeSession,
} from "../src/stripe-provider.js";
import {
  StripeCheckoutsService,
  requirePaymentManager,
} from "../src/stripe-checkouts.js";
import { PaymentsService, PaymentsController } from "../src/payments.js";
import {
  catalogue,
  decryptCredentials,
  encryptCredentials,
} from "../src/providers.js";
const owner: RequestContext = {
  sub: "synthetic-owner",
  businessId: randomUUID(),
  role: "owner",
  entitlements: ["payments"],
  requestId: randomUUID(),
};
const testKey = "sk_test_SyntheticNoProviderUse1234";
function session(
  expected: {
    businessId: string;
    attemptId: string;
    invoiceId: string;
    amountMinor: number;
    currency: string;
    generation: number;
  },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `cs_test_${expected.attemptId.replace(/-/g, "")}`,
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    amount_total: expected.amountMinor,
    currency: expected.currency.toLowerCase(),
    metadata: {
      businessId: expected.businessId,
      attemptId: expected.attemptId,
      invoiceId: expected.invoiceId,
      generation: String(expected.generation),
    },
    payment_status: "unpaid",
    status: "open",
    url: "https://checkout.stripe.com/c/pay/synthetic",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}
test("Stripe credentials accept only test secrets, catalogue exposes only test actions, owner/admin approval and production rejection", () => {
  for (const key of [
    "sk_live_synthetic",
    "rk_live_synthetic",
    "pk_test_synthetic",
    "sk_test_unsafe\nheader",
  ])
    assert.equal(
      stripeCredentialsSchema.safeParse({ secretKey: key }).success,
      false,
    );
  assert.equal(
    stripeCredentialsSchema.safeParse({ secretKey: testKey }).success,
    true,
  );
  assert.equal(
    stripeCredentialsSchema.safeParse({ secretKey: testKey, unknown: "secret" })
      .success,
    false,
  );
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    const stripe = catalogue().find((v) => v.provider === "stripe")!;
    assert.equal(stripe.available, true);
    assert.equal(stripe.mode, "test");
    assert.equal(stripe.capabilities.verifyWebhook, false);
    assert.equal(stripe.capabilities.reconcilePayment, true);
    process.env.NODE_ENV = "production";
    assert.throws(requireStripeTest, /requires_development_or_test/);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
  assert.throws(() => requirePaymentManager({ ...owner, role: "tutor" }), {
    status: 403,
  });
  for (const name of ["verify", "refresh", "disable", "create"] as const)
    assert.deepEqual(
      Reflect.getMetadata(
        "palladium.roles",
        PaymentsController.prototype[name],
      ),
      ["owner", "admin"],
    );
});
test("new payment ciphertext authenticates tenant identity and legacy credentials remain readable", () => {
  const before = process.env.PAYMENT_ENCRYPTION_KEY;
  process.env.PAYMENT_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
  try {
    const value = encryptCredentials({ secretKey: testKey }, owner.businessId);
    assert.deepEqual(decryptCredentials(value, owner.businessId), {
      secretKey: testKey,
    });
    assert.throws(() => decryptCredentials(value, randomUUID()));
    assert.throws(() => decryptCredentials(value));
    assert.deepEqual(
      decryptCredentials(encryptCredentials({ token: "legacy" })),
      { token: "legacy" },
    );
  } finally {
    if (before === undefined) delete process.env.PAYMENT_ENCRYPTION_KEY;
    else process.env.PAYMENT_ENCRYPTION_KEY = before;
  }
});
test("checkout amount comes from minor units and redirects come from configured app; provider validation rejects live/wrong amount/tenant/url", () => {
  const before = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "http://localhost:3000";
  const expected = {
    businessId: owner.businessId,
    attemptId: randomUUID(),
    invoiceId: randomUUID(),
    amountMinor: 1299,
    currency: "USD",
    generation: 1,
  };
  try {
    const p = checkoutPayload(expected);
    assert.equal(p.get("line_items[0][price_data][unit_amount]"), "1299");
    assert.equal(p.get("line_items[0][price_data][currency]"), "usd");
    const success = new URL(p.get("success_url")!);
    assert.equal(success.pathname, "/");
    assert.equal(success.searchParams.get("business"), owner.businessId);
    assert.equal(success.searchParams.get("view"), "payments");
    assert.equal(success.searchParams.get("checkout"), expected.attemptId);
    assert.equal(success.searchParams.get("result"), "success");
    assert.equal(
      new URL(p.get("cancel_url")!).searchParams.get("result"),
      "cancelled",
    );
    assert.throws(
      () => checkoutPayload({ ...expected, currency: "JPY" }),
      /currency_not_supported/,
    );
    validateStripeSession(session(expected), expected);
    for (const bad of [
      { livemode: true },
      { amount_total: 1300 },
      { currency: "eur" },
      { metadata: { businessId: randomUUID() } },
      { id: "cs_live_invalid" },
      { url: "https://evil.example/checkout" },
      { payment_status: "paid", status: "open" },
    ])
      assert.throws(() =>
        validateStripeSession(session(expected, bad), expected),
      );
  } finally {
    if (before === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = before;
  }
});
test(
  "PostgreSQL two-phase Stripe creation, same-key uncertain retry, tenant isolation and verified once-only allocation",
  { skip: !process.env.PAYMENTS_TEST_DATABASE_URL },
  async () => {
    const before = {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      PAYMENT_ENCRYPTION_KEY: process.env.PAYMENT_ENCRYPTION_KEY,
      PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    };
    process.env.DATABASE_URL = process.env.PAYMENTS_TEST_DATABASE_URL;
    process.env.NODE_ENV = "test";
    process.env.PAYMENT_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
    process.env.PUBLIC_APP_URL = "http://localhost:3000";
    const db = new Database(),
      client = new StripeClient(),
      stripe = new StripeCheckoutsService(db, client),
      service = new PaymentsService(
        db,
        { subscribe: () => {} } as unknown as EventBus,
        stripe,
      ),
      other = { ...owner, businessId: randomUUID() };
    const calls: {
      method: string;
      path: string;
      key?: string;
      body?: string;
    }[] = [];
    let creationFailure = true,
      paid = false,
      invalid: Record<string, unknown> = {};
    const invoiceId = randomUUID();
    let attemptId = "";
    try {
      await db.migrate(
        fileURLToPath(new URL("../migrations", import.meta.url)),
      );
      const role = (
        await db.pool.query(
          "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
      client.request = async (method, path, key, body, providerKey) => {
        assert.equal(key, testKey);
        calls.push({ method, path, key: providerKey, body: body?.toString() });
        if (path === "/v1/account") return { id: "acct_Synthetic123" };
        const persisted = await db.withTenant(
          owner.businessId,
          async (tx) =>
            (
              await tx.query(
                "SELECT * FROM payment_attempts WHERE business_id=$1 AND invoice_id=$2",
                [owner.businessId, invoiceId],
              )
            ).rows[0],
        );
        assert.ok(persisted, "attempt is committed before provider request");
        attemptId = persisted.id;
        if (method === "POST" && creationFailure) {
          creationFailure = false;
          throw new StripeError("synthetic_transport_timeout", true);
        }
        return session(
          {
            businessId: owner.businessId,
            attemptId: persisted.id,
            invoiceId,
            amountMinor: 1299,
            currency: "USD",
            generation: 1,
          },
          {
            ...(paid
              ? { payment_status: "paid", status: "complete", url: null }
              : {}),
            ...invalid,
          },
        );
      };
      const connection = await service.createConnection(
        owner,
        {
          provider: "stripe",
          displayName: "Synthetic Stripe",
          credentials: { secretKey: testKey },
        },
        "stripe-connection",
      );
      assert.equal(calls.length, 0, "configure never contacts Stripe");
      assert.equal(connection.mode, "test");
      assert.equal(JSON.stringify(connection).includes(testKey), false);
      assert.equal((await service.connections(other)).length, 0);
      await service.verifyConnection(owner, connection.id);
      assert.equal(calls.length, 1);
      assert.equal(
        (await service.connections(owner))[0].config.verificationStatus,
        "verified",
      );
      await db.withTenant(owner.businessId, (tx) =>
        tx.query(
          "INSERT INTO invoice_snapshots(business_id,invoice_id,amount_minor,currency,issued_event_id) VALUES($1,$2,1299,'USD',$3)",
          [owner.businessId, invoiceId, randomUUID()],
        ),
      );
      const input = { invoiceId, connectionId: connection.id };
      const unknown = await service.create(owner, input, "checkout-a");
      assert.equal(unknown.creationStatus, "unknown");
      assert.equal(unknown.checkoutUrl, null);
      assert.equal(unknown.status, "pending");
      await assert.rejects(service.get(other, unknown.id), { status: 404 });
      assert.equal(
        (
          await db.pool.query("SELECT * FROM payment_attempts WHERE id=$1", [
            unknown.id,
          ])
        ).rowCount,
        0,
      );
      await assert.rejects(service.refresh(owner, unknown.id), { status: 409 });
      const ready = await service.create(owner, input, "checkout-a");
      assert.equal(ready.creationStatus, "ready");
      assert.match(ready.providerReference, /^cs_test_/);
      assert.equal(
        ready.checkoutUrl,
        "https://checkout.stripe.com/c/pay/synthetic",
      );
      const posts = calls.filter((c) => c.method === "POST");
      assert.equal(posts.length, 2);
      assert.equal(posts[0].key, posts[1].key);
      assert.equal(posts[0].body, posts[1].body);
      assert.equal(
        (await service.create(owner, input, "checkout-b")).id,
        ready.id,
      );
      assert.equal(calls.filter((c) => c.method === "POST").length, 2);
      assert.equal((await service.refresh(owner, ready.id)).status, "pending");
      paid = true;
      invalid = { amount_total: 1300 };
      await assert.rejects(
        service.refresh(owner, ready.id),
        /invoice_or_tenant_mismatch/,
      );
      assert.equal((await service.get(owner, ready.id)).status, "pending");
      invalid = { livemode: true };
      await assert.rejects(service.refresh(owner, ready.id), /invalid_or_live/);
      invalid = { metadata: { businessId: other.businessId } };
      await assert.rejects(
        service.refresh(owner, ready.id),
        /invoice_or_tenant_mismatch/,
      );
      invalid = {};
      const confirmations = await Promise.all([
        service.refresh(owner, ready.id),
        service.refresh(owner, ready.id),
      ]);
      assert.ok(
        confirmations.every(
          (c) => c.status === "confirmed" && c.simulated === true,
        ),
      );
      await service.refresh(owner, ready.id);
      await db.withTenant(owner.businessId, async (tx) => {
        assert.equal(
          Number(
            (
              await tx.query(
                "SELECT confirmed_minor FROM invoice_snapshots WHERE business_id=$1 AND invoice_id=$2",
                [owner.businessId, invoiceId],
              )
            ).rows[0].confirmed_minor,
          ),
          1299,
        );
        assert.equal(
          (
            await tx.query(
              "SELECT * FROM provider_events WHERE business_id=$1",
              [owner.businessId],
            )
          ).rowCount,
          1,
        );
        const events = (
          await tx.query(
            "SELECT event FROM service_outbox WHERE event->>'businessId'=$1 AND event->>'type'='payments.payment-confirmed.v1'",
            [owner.businessId],
          )
        ).rows;
        assert.equal(events.length, 1);
        assert.equal(events[0].event.data.simulated, true);
        assert.equal(events[0].event.data.provider, "stripe");
      });
      const conn2 = await service.createConnection(
        owner,
        {
          provider: "stripe",
          displayName: "Other synthetic",
          credentials: { secretKey: testKey },
        },
        "stripe-connection-2",
      );
      await assert.rejects(
        service.create(
          owner,
          { ...input, connectionId: conn2.id },
          "different-connection",
        ),
        { status: 409 },
      );
      await service.disableConnection(owner, connection.id);
      assert.equal(
        (await service.connections(owner)).find((c) => c.id === connection.id)
          ?.status,
        "disabled",
      );
      // A separate unresolved attempt beyond Stripe's retention window must never trigger a new provider request.
      const oldInvoice = randomUUID(),
        oldAttempt = randomUUID();
      const count = calls.length;
      await db.withTenant(owner.businessId, async (tx) => {
        await tx.query(
          "INSERT INTO invoice_snapshots(business_id,invoice_id,amount_minor,currency,issued_event_id) VALUES($1,$2,100,'USD',$3)",
          [owner.businessId, oldInvoice, randomUUID()],
        );
        await tx.query(
          "INSERT INTO payment_attempts(id,business_id,invoice_id,connection_id,provider,amount_minor,currency,status,provider_reference,simulated,creation_status) VALUES($1,$2,$3,$4,'stripe',100,'USD','pending',$5,true,'unknown')",
          [
            oldAttempt,
            owner.businessId,
            oldInvoice,
            conn2.id,
            `stripe:${oldAttempt}:1`,
          ],
        );
        await tx.query(
          "INSERT INTO stripe_checkout_sessions(business_id,attempt_id,generation,payload,status,created_at) VALUES($1,$2,1,'{}','unknown',now()-interval '25 hours')",
          [owner.businessId, oldAttempt],
        );
      });
      const blocked = await service.create(
        owner,
        { invoiceId: oldInvoice, connectionId: conn2.id },
        "old-window",
      );
      assert.equal(
        blocked.lastError,
        "stripe_idempotency_window_expired_manual_reconciliation_required",
      );
      assert.equal(calls.length, count);
    } finally {
      await db.withTenant(owner.businessId, async (tx) => {
        await tx.query(
          "DELETE FROM stripe_checkout_sessions WHERE business_id=$1",
          [owner.businessId],
        );
        await tx.query("DELETE FROM provider_events WHERE business_id=$1", [
          owner.businessId,
        ]);
        await tx.query("DELETE FROM payment_attempts WHERE business_id=$1", [
          owner.businessId,
        ]);
        await tx.query("DELETE FROM invoice_snapshots WHERE business_id=$1", [
          owner.businessId,
        ]);
        await tx.query(
          "DELETE FROM payments_idempotency WHERE business_id=$1",
          [owner.businessId],
        );
        await tx.query("DELETE FROM payment_connections WHERE business_id=$1", [
          owner.businessId,
        ]);
        await tx.query(
          "DELETE FROM service_outbox WHERE event->>'businessId'=$1",
          [owner.businessId],
        );
      });
      await db.pool.end();
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
