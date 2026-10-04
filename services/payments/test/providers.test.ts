import assert from "node:assert/strict";
import test from "node:test";
import {
  adapter,
  catalogue,
  decryptCredentials,
  encryptCredentials,
  nextPaymentStatus,
  sandboxEnabled,
} from "../src/providers.js";
import { requestHash } from "../src/idempotency.js";
test("sandbox requires explicit enablement and cannot run in production", () => {
  assert.equal(sandboxEnabled({}), false);
  assert.equal(sandboxEnabled({ ALLOW_SANDBOX_PAYMENTS: "true" }), false);
  assert.equal(
    sandboxEnabled({ NODE_ENV: "staging", ALLOW_SANDBOX_PAYMENTS: "true" }),
    false,
  );
  assert.equal(
    sandboxEnabled({ NODE_ENV: "development", ALLOW_SANDBOX_PAYMENTS: "true" }),
    true,
  );
  assert.equal(
    sandboxEnabled({ NODE_ENV: "production", ALLOW_SANDBOX_PAYMENTS: "true" }),
    false,
  );
});
test("unsupported PayPal and bank providers explicitly reject operations", () => {
  for (const provider of ["paypal", "bank"] as const) {
    const entry = catalogue().find((item) => item.provider === provider)!;
    assert.equal(entry.available, false);
    assert.deepEqual(entry.capabilities, {
      createCheckout: false,
      getPayment: false,
      reconcilePayment: false,
      verifyWebhook: false,
      refund: false,
    });
    assert.throws(
      () => adapter(provider),
      new RegExp(`${provider}_integration_unavailable`),
    );
  }
});
test("credentials encrypt with randomized authenticated ciphertext and detect tampering", () => {
  const old = process.env.PAYMENT_ENCRYPTION_KEY;
  process.env.PAYMENT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    const original = { token: "synthetic-secret" },
      first = encryptCredentials(original),
      second = encryptCredentials(original);
    assert.notEqual(first, second);
    assert.equal(first.includes(original.token), false);
    assert.deepEqual(decryptCredentials(first), original);
    const chunks = first.split(".");
    const altered = Buffer.from(chunks[3], "base64");
    altered[0] ^= 1;
    chunks[3] = altered.toString("base64");
    assert.throws(() => decryptCredentials(chunks.join(".")));
  } finally {
    if (old === undefined) delete process.env.PAYMENT_ENCRYPTION_KEY;
    else process.env.PAYMENT_ENCRYPTION_KEY = old;
  }
});
test("confirmed payment remains confirmed after duplicate or out of order pending notices", () => {
  assert.equal(nextPaymentStatus("pending", "pending"), "pending");
  assert.equal(nextPaymentStatus("pending", "confirmed"), "confirmed");
  assert.equal(nextPaymentStatus("confirmed", "confirmed"), "confirmed");
  assert.equal(nextPaymentStatus("confirmed", "pending"), "confirmed");
});
test("checkout idempotency changes when merchant connection or invoice changes", () => {
  assert.equal(
    requestHash({ invoiceId: "a", connectionId: "b" }),
    requestHash({ connectionId: "b", invoiceId: "a" }),
  );
  assert.notEqual(
    requestHash({ invoiceId: "a", connectionId: "b" }),
    requestHash({ invoiceId: "a", connectionId: "c" }),
  );
});
test("sandbox adapter accepts only the persisted business connection and attempt identity", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_SANDBOX_PAYMENTS: process.env.ALLOW_SANDBOX_PAYMENTS,
  };
  process.env.NODE_ENV = "test";
  process.env.ALLOW_SANDBOX_PAYMENTS = "true";
  try {
    const selected = adapter("sandbox");
    const connection = {
      id: "merchant",
      businessId: "business-a",
      provider: "sandbox",
      credentials: {},
    };
    const attempt = {
      id: "attempt",
      businessId: "business-a",
      connectionId: "merchant",
      provider: "sandbox",
      status: "pending",
      amountMinor: 100,
      currency: "USD",
      providerReference: "sandbox:attempt",
    };
    assert.deepEqual(selected.createCheckout(connection, attempt), {
      providerReference: "sandbox:attempt",
      checkoutUrl: null,
      simulated: true,
    });
    assert.deepEqual(selected.getPayment(connection, attempt), {
      status: "pending",
      simulated: true,
    });
    assert.throws(
      () =>
        selected.createCheckout(
          { ...connection, businessId: "business-b" },
          attempt,
        ),
      /payment_connection_mismatch/,
    );
    assert.throws(
      () => selected.verifyWebhook(connection, Buffer.from("{}"), {}),
      /sandbox_has_no_external_webhook/,
    );
    assert.throws(
      () => selected.refund(connection, attempt),
      /refund_unsupported/,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
