import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
export class CommunicationError extends Error {
  constructor(
    public readonly safeMessage: string,
    public readonly ambiguous = false,
  ) {
    super(safeMessage);
  }
}
function key() {
  const v = process.env.COMMUNICATIONS_ENCRYPTION_KEY ?? "";
  const b = /^[a-f\d]{64}$/i.test(v)
    ? Buffer.from(v, "hex")
    : Buffer.from(v, "base64");
  if (b.length !== 32)
    throw new CommunicationError("Communication encryption is not configured");
  return b;
}
export function encryptCredentials(value: unknown, businessId: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(businessId));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function decryptCredentials(
  value: string,
  businessId: string,
): Record<string, string> {
  try {
    const [iv, tag, data] = value
      .split(".")
      .map((p) => Buffer.from(p, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", key(), iv!);
    cipher.setAAD(Buffer.from(businessId));
    cipher.setAuthTag(tag!);
    return JSON.parse(
      Buffer.concat([cipher.update(data!), cipher.final()]).toString(),
    );
  } catch {
    throw new CommunicationError(
      "Stored communication credentials could not be opened",
    );
  }
}
export const deliveryEnabled = () =>
  process.env.ALLOW_OUTBOUND_DELIVERY === "true";
export function assertDeliveryEnabled() {
  if (!deliveryEnabled())
    throw new CommunicationError("Outbound delivery is disabled");
}
export function publicIp(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const n = address.toLowerCase(),
      second = parseInt(n.split(":")[1] || "0", 16);
    return (
      /^[23][a-f\d]{3}:/.test(n) &&
      !n.startsWith("2002:") &&
      !n.startsWith("3fff:") &&
      !(n.startsWith("2001:") && (second < 0x200 || second === 0xdb8))
    );
  }
  return false;
}
export function httpsEndpoint(input: string) {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new CommunicationError("Invalid HTTPS endpoint");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== "443")
  )
    throw new CommunicationError(
      "Endpoint must be HTTPS on port 443 without URL credentials",
    );
  return u;
}
export async function resolvePublicHost(hostname: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
          lookup(hostname, { all: true }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new CommunicationError("DNS resolution timed out")),
              5000,
            );
            timer.unref();
          }),
        ]);
    if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
      throw new CommunicationError(
        "Provider must resolve only to public addresses",
      );
    return addresses[0]!;
  } catch (e) {
    if (e instanceof CommunicationError) throw e;
    throw new CommunicationError("Provider DNS resolution failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Public DNS validation and pinned lookup, no redirects, bounded bodies and overall timeout. */
export async function safeJsonPost(
  input: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const url = httpsEndpoint(input),
    selected = await resolvePublicHost(url.hostname.replace(/^\[|\]$/g, "")),
    data = JSON.stringify(body);
  if (Buffer.byteLength(data) > 128 * 1024)
    throw new CommunicationError("Provider request exceeded limit");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
        lookup: ((_h: any, opts: any, cb: any) =>
          opts?.all
            ? cb(null, [selected])
            : cb(null, selected.address, selected.family)) as any,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(
            new CommunicationError(
              status >= 300 && status < 400
                ? "Provider redirects are not allowed"
                : `Provider rejected request (HTTP ${status})`,
              status >= 500 || status === 408,
            ),
          );
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 128 * 1024) {
            reject(
              new CommunicationError("Provider response exceeded limit", true),
            );
            req.destroy();
          } else chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(
              new CommunicationError("Provider returned invalid JSON", true),
            );
          }
        });
        res.on("error", () =>
          reject(
            new CommunicationError("Provider response was interrupted", true),
          ),
        );
      },
    );
    const timer = setTimeout(() => {
      reject(
        new CommunicationError(
          "Provider request timed out; acceptance is unknown",
          true,
        ),
      );
      req.destroy();
    }, 15000);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", () =>
      reject(
        new CommunicationError(
          "Provider connection failed; acceptance is unknown",
          true,
        ),
      ),
    );
    req.end(data);
  });
}
