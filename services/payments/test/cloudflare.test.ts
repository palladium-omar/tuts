import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareStripeRequest, StripeError } from "../src/stripe-provider.js";

test("Worker Stripe transport preserves fixed origin, idempotency and test restriction", async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "test";
  try {
    const transport: typeof fetch = async (input, init) => {
      assert.equal(input, "https://api.stripe.com/v1/checkout/sessions");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as any)["Idempotency-Key"], "synthetic-retry-key");
      return Response.json({ id: "cs_test_synthetic" });
    };
    assert.deepEqual(await cloudflareStripeRequest("POST", "/v1/checkout/sessions", "sk_test_synthetic123", new URLSearchParams({ mode: "payment" }), "synthetic-retry-key", transport), { id: "cs_test_synthetic" });
    await assert.rejects(cloudflareStripeRequest("POST", "//evil.example", "sk_test_synthetic123", undefined, undefined, transport), /endpoint_invalid/);
    process.env.NODE_ENV = "production";
    await assert.rejects(cloudflareStripeRequest("GET", "/v1/account", "sk_test_synthetic123", undefined, undefined, transport), /requires_development_or_test/);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
test("Worker Stripe transport failures retain uncertain POST acceptance", async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "test";
  try {
    await assert.rejects(cloudflareStripeRequest("POST", "/v1/checkout/sessions", "sk_test_synthetic123", undefined, "synthetic", async () => { throw new Error("Interrupted"); }), (error: unknown) => error instanceof StripeError && error.unknown);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
