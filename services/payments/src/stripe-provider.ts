import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { isCloudflareRuntime } from "@palladium/service-kit";
import { request } from "node:https";
import { z } from "zod";
export const stripeCredentialsSchema = z
  .object({
    secretKey: z
      .string()
      .max(500)
      .regex(/^(?:sk|rk)_test_[A-Za-z0-9]{8,}$/),
    webhookSecret: z
      .string()
      .max(500)
      .regex(/^whsec_[A-Za-z0-9]+$/)
      .optional(),
  })
  .strict();
export function stripeTestEnabled() {
  return (
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
  );
}
export function requireStripeTest() {
  if (!stripeTestEnabled())
    throw new ServiceUnavailableException(
      "stripe_test_mode_requires_development_or_test",
    );
}
export class StripeError extends Error {
  constructor(
    public readonly safeMessage: string,
    public readonly unknown = false,
    public readonly httpStatus?: number,
  ) {
    super(safeMessage);
  }
}
export const stripeSessionSchema = z.object({
  id: z
    .string()
    .max(300)
    .regex(/^cs_test_[A-Za-z0-9]+$/),
  object: z.literal("checkout.session"),
  livemode: z.literal(false),
  mode: z.literal("payment"),
  amount_total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[a-z]{3}$/),
  metadata: z.record(z.string(), z.string()),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  status: z.enum(["open", "complete", "expired"]),
  url: z.string().nullable(),
  expires_at: z.number().int().positive(),
});
export type StripeSession = z.infer<typeof stripeSessionSchema>;
export type StripeTransport = (
  method: "GET" | "POST",
  path: string,
  secretKey: string,
  body?: URLSearchParams,
  idempotencyKey?: string,
) => Promise<unknown>;
/** The only external host is api.stripe.com. TLS validation, no redirects, bounded request and response. */
export const stripeRequest: StripeTransport = async (
  method,
  path,
  secretKey,
  body,
  idempotencyKey,
) => {
  if (
    !/^\/v1\/(?:account|checkout\/sessions(?:\/cs_test_[A-Za-z0-9]+)?)$/.test(
      path,
    )
  )
    throw new StripeError("stripe_endpoint_invalid");
  stripeCredentialsSchema.pick({ secretKey: true }).parse({ secretKey });
  requireStripeTest();
  const data = body?.toString() ?? "";
  if (Buffer.byteLength(data) > 32 * 1024)
    throw new StripeError("stripe_request_too_large");
  if (isCloudflareRuntime()) return cloudflareStripeRequest(method, path, secretKey, body, idempotencyKey);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: "api.stripe.com",
        port: 443,
        path,
        method,
        agent: false,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: "application/json",
          ...(method === "POST"
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(data),
                "Idempotency-Key": idempotencyKey!,
              }
            : {}),
        },
      },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code < 200 || code >= 300) {
          res.resume();
          reject(
            new StripeError(
              code >= 300 && code < 400
                ? "stripe_redirect_rejected"
                : `stripe_request_rejected_http_${code}`,
              code >= 500 || code === 408 || code === 409,
              code,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 128 * 1024) {
            reject(
              new StripeError("stripe_response_too_large", method === "POST"),
            );
            req.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(
              new StripeError("stripe_response_invalid", method === "POST"),
            );
          }
        });
        res.on("error", () =>
          reject(
            new StripeError("stripe_response_interrupted", method === "POST"),
          ),
        );
      },
    );
    const timer = setTimeout(() => {
      reject(new StripeError("stripe_request_timed_out", method === "POST"));
      req.destroy();
    }, 15000);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", () =>
      reject(new StripeError("stripe_connection_failed", method === "POST")),
    );
    req.end(data);
  });
};
export function validateStripeSession(
  raw: unknown,
  expected: {
    businessId: string;
    attemptId: string;
    invoiceId: string;
    amountMinor: number;
    currency: string;
    generation: number;
  },
  reference?: string,
) {
  const parsed = stripeSessionSchema.safeParse(raw);
  if (!parsed.success)
    throw new StripeError("stripe_session_response_invalid_or_live", true);
  const s = parsed.data;
  if (
    (reference && s.id !== reference) ||
    s.amount_total !== expected.amountMinor ||
    s.currency !== expected.currency.toLowerCase() ||
    s.metadata.businessId !== expected.businessId ||
    s.metadata.attemptId !== expected.attemptId ||
    s.metadata.invoiceId !== expected.invoiceId ||
    s.metadata.generation !== String(expected.generation)
  )
    throw new StripeError("stripe_session_invoice_or_tenant_mismatch", true);
  if (s.url) {
    let u: URL;
    try {
      u = new URL(s.url);
    } catch {
      throw new StripeError("stripe_checkout_url_invalid", true);
    }
    if (
      u.protocol !== "https:" ||
      u.hostname !== "checkout.stripe.com" ||
      u.username ||
      u.password ||
      u.port
    )
      throw new StripeError("stripe_checkout_url_invalid", true);
  }
  if (s.payment_status === "paid" && s.status !== "complete")
    throw new StripeError("stripe_paid_session_not_complete", true);
  return s;
}
const supportedCurrencies = new Set([
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "CHF",
  "AED",
  "MAD",
]);
export function assertStripeCurrency(currency: string) {
  if (!supportedCurrencies.has(currency))
    throw new UnprocessableEntityException(
      "stripe_currency_not_supported_by_this_adapter",
    );
}
export function checkoutPayload(value: {
  businessId: string;
  attemptId: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  generation: number;
}) {
  assertStripeCurrency(value.currency);
  if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor <= 0)
    throw new UnprocessableEntityException("stripe_amount_invalid");
  let root: URL;
  try {
    root = new URL(process.env.PUBLIC_APP_URL ?? "");
    if (
      root.username ||
      root.password ||
      root.search ||
      root.hash ||
      !["http:", "https:"].includes(root.protocol)
    )
      throw new Error();
    if (
      root.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(root.hostname)
    )
      throw new Error();
  } catch {
    throw new ServiceUnavailableException("public_app_url_missing_or_invalid");
  }
  const page = new URL("/", root);
  page.searchParams.set("business", value.businessId);
  page.searchParams.set("view", "payments");
  page.searchParams.set("checkout", value.attemptId);
  const success = new URL(page);
  success.searchParams.set("result", "success");
  const cancel = new URL(page);
  cancel.searchParams.set("result", "cancelled");
  const params = new URLSearchParams({
    mode: "payment",
    success_url: success.href,
    cancel_url: cancel.href,
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": value.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(value.amountMinor),
    "line_items[0][price_data][product_data][name]": `Invoice ${value.invoiceId}`,
    "line_items[0][quantity]": "1",
    client_reference_id: value.attemptId,
  });
  for (const [name, entry] of Object.entries({
    businessId: value.businessId,
    attemptId: value.attemptId,
    invoiceId: value.invoiceId,
    generation: String(value.generation),
  }))
    params.set(`metadata[${name}]`, entry);
  return params;
}
@Injectable()
export class StripeClient {
  request: StripeTransport = stripeRequest;
}

/** Fetch adapter preserves the fixed Stripe origin and ambiguity after attempted POST acceptance. */
export async function cloudflareStripeRequest(method: "GET" | "POST", path: string, secretKey: string, body?: URLSearchParams, idempotencyKey?: string, transport: typeof fetch = fetch): Promise<unknown> {
  if (!/^\/v1\/(?:account|checkout\/sessions(?:\/cs_test_[A-Za-z0-9]+)?)$/.test(path)) throw new StripeError("stripe_endpoint_invalid");
  stripeCredentialsSchema.pick({ secretKey: true }).parse({ secretKey });
  requireStripeTest();
  const data = body?.toString() ?? "";
  if (Buffer.byteLength(data) > 32 * 1024) throw new StripeError("stripe_request_too_large");
  try {
    const response = await transport(`https://api.stripe.com${path}`, {
      method, headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idempotencyKey! } : {}) },
      ...(method === "POST" ? { body: data } : {}), redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new StripeError(`stripe_request_rejected_http_${response.status}`, response.status >= 500 || response.status === 408 || response.status === 409, response.status);
    }
    if (!response.body) throw new StripeError("stripe_response_invalid", method === "POST");
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 128 * 1024) { await reader.cancel(); throw new StripeError("stripe_response_too_large", method === "POST"); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new StripeError("stripe_response_invalid", method === "POST"); }
  } catch (error) {
    if (error instanceof StripeError) throw error;
    throw new StripeError("stripe_connection_failed", method === "POST");
  }
}
