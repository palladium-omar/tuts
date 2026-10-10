import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const path = new URL("../.env", import.meta.url);
let current = "";
try {
  current = await readFile(path, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const existing = parseEnv(current);
const token = () => randomBytes(24).toString("hex");
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const defaults = {
  NODE_ENV: "development",
  PUBLIC_APP_URL: "http://localhost:3000",
  PUBLIC_GATEWAY_URL: "http://localhost:8080",
  NEXT_PUBLIC_GATEWAY_URL: "http://localhost:8080",
  POSTGRES_PASSWORD: token(),
  RABBITMQ_USER: "palladium",
  RABBITMQ_PASSWORD: token(),
  CONTEXT_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
  CONTEXT_PUBLIC_KEY: publicKey.replace(/\n/g, "\\n"),
  PLATFORM_INTERNAL_SECRET: token(),
  BETTER_AUTH_SECRET: token(),
  AUTH_MAIL_INTERNAL_SECRET: token(),
  PORTAL_INTERNAL_SECRET: token(),
  AUTH_MAIL_ENABLED: "false",
  PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  COMMUNICATIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ALLOW_OUTBOUND_DELIVERY: "false",
  ALLOW_SANDBOX_PAYMENTS: "true",
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
  "planning",
  "reporting",
])
  defaults[`${name.toUpperCase()}_DB_PASSWORD`] = token();
if (
  Boolean(existing.CONTEXT_PRIVATE_KEY) !== Boolean(existing.CONTEXT_PUBLIC_KEY)
)
  throw new Error(
    "Both signing keys must exist together. Restore the matching key pair.",
  );
const missing = Object.entries(defaults).filter(
  ([key]) => existing[key] === undefined,
);
if (missing.length) {
  const additions = missing
    .map(([key, value]) => `${key}="${value}"`)
    .join("\n");
  await writeFile(
    path,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}${additions}\n`,
    { mode: 0o600 },
  );
}
console.log(
  `Local settings ready. Added ${missing.length} missing settings; existing credentials preserved.`,
);
