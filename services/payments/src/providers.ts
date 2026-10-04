import {
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { stripeTestEnabled } from "./stripe-provider.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export const providers = ["sandbox", "stripe", "paypal", "bank"] as const;
export type Provider = (typeof providers)[number];
export function sandboxEnabled(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.ALLOW_SANDBOX_PAYMENTS === "true" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test")
  );
}
export function requireSandbox() {
  if (!sandboxEnabled())
    throw new ServiceUnavailableException("sandbox_payments_disabled");
}
function encryptionKey() {
  const encoded = process.env.PAYMENT_ENCRYPTION_KEY;
  if (!encoded)
    throw new ServiceUnavailableException("payment_encryption_key_missing");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new ServiceUnavailableException("payment_encryption_key_invalid");
  return key;
}
export function encryptCredentials(
  value: Record<string, string>,
  businessId?: string,
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  if (businessId) cipher.setAAD(Buffer.from(businessId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    businessId ? "v2" : "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}
export function decryptCredentials(
  value: string,
  businessId?: string,
): Record<string, string> {
  const [version, iv, tag, ciphertext, ...extra] = value.split(".");
  if (
    !["v1", "v2"].includes(version) ||
    !iv ||
    !tag ||
    !ciphertext ||
    extra.length
  )
    throw new BadRequestException("encrypted_credentials_invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  if (version === "v2") {
    if (!businessId)
      throw new BadRequestException("encrypted_credentials_tenant_required");
    decipher.setAAD(Buffer.from(businessId));
  }
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}
export function catalogue() {
  return providers.map((provider) => {
    const available =
      provider === "sandbox"
        ? sandboxEnabled()
        : provider === "stripe"
          ? stripeTestEnabled()
          : false;
    return {
      provider,
      displayName: {
        sandbox: "Sandbox (simulated)",
        stripe: "Stripe (existing account, test mode)",
        paypal: "PayPal Commerce Platform",
        bank: "Bank provider",
      }[provider],
      available,
      simulated: provider === "sandbox" || provider === "stripe",
      mode:
        provider === "stripe"
          ? "test"
          : provider === "sandbox"
            ? "sandbox"
            : null,
      reason: available
        ? null
        : provider === "sandbox"
          ? "sandbox_payments_disabled"
          : provider === "stripe"
            ? "stripe_test_mode_requires_development_or_test"
            : "integration_unavailable",
      capabilities: {
        createCheckout: available,
        getPayment: available,
        reconcilePayment: provider === "stripe" && available,
        verifyWebhook: false,
        refund: false,
      },
    };
  });
}
export interface AdapterConnection {
  id: string;
  businessId: string;
  provider: string;
  credentials: Record<string, string>;
}
export interface Attempt {
  id: string;
  businessId: string;
  connectionId: string;
  provider: string;
  status: string;
  amountMinor: number;
  currency: string;
  providerReference: string;
}
export interface PaymentAdapter {
  createCheckout(
    connection: AdapterConnection,
    attempt: Attempt,
  ): {
    providerReference: string;
    checkoutUrl: null;
    simulated: boolean;
  };
  getPayment(
    connection: AdapterConnection,
    attempt: Attempt,
  ): {
    status: string;
    simulated: boolean;
  };
  verifyWebhook(
    connection: AdapterConnection,
    raw: Buffer,
    headers: Record<string, string>,
  ): never;
  refund(connection: AdapterConnection, attempt: Attempt): never;
}
export function adapter(provider: Provider): PaymentAdapter {
  if (provider !== "sandbox")
    throw new UnprocessableEntityException(
      `${provider}_integration_unavailable`,
    );
  requireSandbox();
  return {
    createCheckout: (connection, attempt) => {
      if (
        connection.id !== attempt.connectionId ||
        connection.businessId !== attempt.businessId ||
        connection.provider !== attempt.provider
      )
        throw new BadRequestException("payment_connection_mismatch");
      return {
        providerReference: `sandbox:${attempt.id}`,
        checkoutUrl: null,
        simulated: true,
      };
    },
    getPayment: (connection, attempt) => {
      if (
        connection.id !== attempt.connectionId ||
        connection.businessId !== attempt.businessId ||
        connection.provider !== attempt.provider
      )
        throw new BadRequestException("payment_connection_mismatch");
      return { status: attempt.status, simulated: true };
    },
    verifyWebhook: () => {
      throw new UnprocessableEntityException("sandbox_has_no_external_webhook");
    },
    refund: () => {
      throw new UnprocessableEntityException("refund_unsupported");
    },
  };
}
export function nextPaymentStatus(
  current: "pending" | "confirmed",
  notification: "pending" | "confirmed",
) {
  return current === "confirmed" || notification === "confirmed"
    ? "confirmed"
    : "pending";
}
