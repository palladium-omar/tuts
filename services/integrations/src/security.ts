import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
export class ConnectorError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
  }
}
function key() {
  const value = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? "";
  const decoded = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32)
    throw new ConnectorError("Integration encryption key is not configured");
  return decoded;
}
export function encrypt(value: unknown, businessId: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(businessId));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function decrypt(value: string, businessId: string): { token?: string } {
  const parts = value.split(".").map((p) => Buffer.from(p, "base64url"));
  if (parts.length !== 3)
    throw new ConnectorError("Stored credentials could not be opened");
  try {
    const cipher = createDecipheriv("aes-256-gcm", key(), parts[0]!);
    cipher.setAAD(Buffer.from(businessId));
    cipher.setAuthTag(parts[1]!);
    return JSON.parse(
      Buffer.concat([cipher.update(parts[2]!), cipher.final()]).toString(
        "utf8",
      ),
    );
  } catch {
    throw new ConnectorError("Stored credentials could not be opened");
  }
}
export const hashSecret = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
function publicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
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
    const normalized = address.toLowerCase();
    const second = parseInt(normalized.split(":")[1] || "0", 16);
    return (
      /^[23][a-f\d]{3}:/.test(normalized) &&
      !(
        normalized.startsWith("2001:") &&
        (second < 0x200 || second === 0xdb8)
      ) &&
      !normalized.startsWith("2002:") &&
      !normalized.startsWith("3fff:")
    );
  }
  return false;
}
/** Resolve all addresses, reject any private/special address, and pin the approved address at connect time. No redirects. */
export async function safeJsonGet(
  input: string,
  headers: Record<string, string> = {},
): Promise<any> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConnectorError("Invalid endpoint URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new ConnectorError(
      "Endpoint must use HTTPS on port 443 without credentials",
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new ConnectorError("Endpoint DNS timed out")),
            5000,
          );
          timer.unref();
        }),
      ]).catch(() => {
        throw new ConnectorError("Endpoint DNS resolution failed");
      });
  if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
    throw new ConnectorError("Endpoint must resolve only to public addresses");
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const fail = (message: string) => reject(new ConnectorError(message));
    const req = request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        agent: false,
        lookup: ((_host: any, opts: any, callback: any) =>
          opts?.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family)) as any,
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          fail(
            res.statusCode && res.statusCode >= 300 && res.statusCode < 400
              ? "Endpoint redirects are not allowed"
              : `Provider request failed (HTTP ${res.statusCode ?? 0})`,
          );
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy();
            fail("Provider response exceeded 2 MB");
          } else chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            fail("Provider returned invalid JSON");
          }
        });
        res.on("error", () => fail("Provider response was interrupted"));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail("Provider request timed out");
    }, 15000);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => fail("Provider connection failed"));
    req.end();
  });
}
