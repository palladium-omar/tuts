import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const target = new URL("../.env.production", import.meta.url);
const domain = process.env.TUTS_DOMAIN ?? "tuts.palladiumscholars.com";
if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".")) {
  throw new Error("TUTS_DOMAIN must be a DNS hostname");
}
let current = "";
try {
  current = await readFile(target, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const existing = parseEnv(current);
if (
  Boolean(existing.CONTEXT_PRIVATE_KEY) !== Boolean(existing.CONTEXT_PUBLIC_KEY)
) {
  throw new Error("Restore the matching signing key pair before continuing");
}
const token = () => randomBytes(24).toString("hex");
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const defaults = {
  TUTS_DOMAIN: domain,
  ACME_EMAIL: "omar@palladiumscholars.com",
  PUBLIC_APP_URL: `https://${domain}`,
  PUBLIC_GATEWAY_URL: `https://${domain}`,
  INITIAL_BUSINESS_ENTITLEMENTS:
    "clients,scheduling,learning,billing,payments,notifications,integrations",
  POSTGRES_PASSWORD: token(),
  RABBITMQ_USER: "tuts",
  RABBITMQ_PASSWORD: token(),
  CONTEXT_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
  CONTEXT_PUBLIC_KEY: publicKey.replace(/\n/g, "\\n"),
  PLATFORM_INTERNAL_SECRET: token(),
  BETTER_AUTH_SECRET: token(),
  AUTH_MAIL_INTERNAL_SECRET: token(),
  AUTH_MAIL_ENABLED: "false",
  PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  COMMUNICATIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ALLOW_OUTBOUND_DELIVERY: "false",
};
for (const name of [
  "platform",
  "clients",
  "scheduling",
  "learning",
  "billing",
  "payments",
  "notifications",
  "integrations",
]) {
  defaults[`${name.toUpperCase()}_DB_PASSWORD`] = token();
}
const missing = Object.entries(defaults).filter(
  ([key]) => existing[key] === undefined,
);
if (missing.length) {
  const additions = missing
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n");
  await writeFile(
    target,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}${additions}\n`,
    { mode: 0o600 },
  );
}
await chmod(target, 0o600);
console.log(
  `Production settings ready; ${missing.length} missing settings generated. Existing credentials preserved.`,
);
