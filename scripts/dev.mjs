import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const settings = parseEnv(await readFile(new URL(".env", root), "utf8"));
const names = [
  "platform",
  "clients",
  "scheduling",
  "learning",
  "billing",
  "payments",
  "notifications",
  "integrations",
];
const configuration = { ...process.env, ...settings };
const systemEnvironment = { ...process.env };
const applicationKeys = new Set([
  ...Object.keys(settings),
  "DATABASE_URL",
  "RABBITMQ_URL",
  "RABBITMQ_USER",
  "CONTEXT_PUBLIC_KEY",
  "CONTEXT_PRIVATE_KEY",
  "PLATFORM_INTERNAL_SECRET",
  "BETTER_AUTH_SECRET",
  "PAYMENT_ENCRYPTION_KEY",
  "ALLOW_SANDBOX_PAYMENTS",
  "PUBLIC_APP_URL",
  "PUBLIC_GATEWAY_URL",
  "NEXT_PUBLIC_GATEWAY_URL",
  "DISABLE_BROKER",
  "NODE_ENV",
  "PORT",
  ...names.map((name) => `${name.toUpperCase()}_URL`),
]);
for (const key of Object.keys(systemEnvironment)) {
  if (
    applicationKeys.has(key) ||
    /SECRET|PASSWORD|TOKEN|PRIVATE_KEY|ENCRYPTION_KEY|API_KEY|CREDENTIAL|ACCESS_KEY/i.test(
      key,
    )
  ) {
    delete systemEnvironment[key];
  }
}
const select = (keys) =>
  Object.fromEntries(
    keys
      .filter((key) => configuration[key] !== undefined)
      .map((key) => [key, configuration[key]]),
  );
const brokerUrl = `amqp://${encodeURIComponent(configuration.RABBITMQ_USER)}:${encodeURIComponent(configuration.RABBITMQ_PASSWORD)}@127.0.0.1:5673`;
const processGroups = process.platform !== "win32";

// Resolve installed entrypoints before starting anything. Running Node directly
// avoids concurrent pnpm workspace-state reads/writes during development startup.
const launches = [...names, "gateway", "web"].map((name, index) => {
  const cwd = new URL(
    `${names.includes(name) ? "services" : "apps"}/${name}/`,
    root,
  );
  const resolve = createRequire(new URL("package.json", cwd)).resolve;
  const args =
    name === "web"
      ? [resolve("next/dist/bin/next"), "dev", "--port", "3000"]
      : [resolve("tsx/cli"), "watch", "src/main.ts"];
  const env = { ...systemEnvironment, ...select(["NODE_ENV"]) };
  if (names.includes(name)) {
    Object.assign(env, select(["CONTEXT_PUBLIC_KEY", "DISABLE_BROKER"]));
    env.RABBITMQ_URL = brokerUrl; // Shared broker credentials are local development only.
    env.PORT = String(4001 + index);
    env.DATABASE_URL = `postgresql://${name}:${encodeURIComponent(configuration[`${name.toUpperCase()}_DB_PASSWORD`])}@127.0.0.1:5434/${name}`;
  }
  if (name === "platform")
    Object.assign(
      env,
      select([
        "PLATFORM_INTERNAL_SECRET",
        "BETTER_AUTH_SECRET",
        "AUTH_MAIL_INTERNAL_SECRET",
        "AUTH_MAIL_ENABLED",
        "PUBLIC_APP_URL",
        "PUBLIC_GATEWAY_URL",
      ]),
      { NOTIFICATIONS_URL: configuration.NOTIFICATIONS_URL || "http://127.0.0.1:4007" },
    );
  if (name === "payments")
    Object.assign(
      env,
      select([
        "PAYMENT_ENCRYPTION_KEY",
        "ALLOW_SANDBOX_PAYMENTS",
        "PUBLIC_APP_URL",
      ]),
    );
  if (name === "integrations")
    Object.assign(env, select(["INTEGRATIONS_ENCRYPTION_KEY"]));
  if (name === "notifications") {
    Object.assign(
      env,
      select(["COMMUNICATIONS_ENCRYPTION_KEY", "ALLOW_OUTBOUND_DELIVERY", "PUBLIC_APP_URL", "AUTH_MAIL_INTERNAL_SECRET", "AUTH_MAIL_ENABLED", "AUTH_MAIL_PROVIDER", "AUTH_MAIL_FROM", "AUTH_MAIL_API_KEY"]),
    );
    env.CLIENTS_URL = configuration.CLIENTS_URL || "http://127.0.0.1:4002";
  }
  if (name === "billing")
    env.SCHEDULING_URL =
      configuration.SCHEDULING_URL || "http://127.0.0.1:4003";
  if (name === "learning")
    env.UPLOAD_DIRECTORY = new URL(".local/uploads/", root).pathname;
  if (name === "gateway") {
    Object.assign(
      env,
      select([
        "CONTEXT_PRIVATE_KEY",
        "PLATFORM_INTERNAL_SECRET",
        "PUBLIC_APP_URL",
        "PUBLIC_GATEWAY_URL",
        ...names.map((service) => `${service.toUpperCase()}_URL`),
      ]),
    );
    env.PORT = "8080";
  }
  if (name === "web") Object.assign(env, select(["NEXT_PUBLIC_GATEWAY_URL"]));
  return { name, cwd, args, env };
});

const children = new Set();
let stopping = false;
let exitCode = 0;
let shutdownTimer;

function signalChild(child, signal) {
  if (!child.pid) return;
  try {
    // tsx watch and Next spawn workers; signal their whole process group on Unix.
    if (processGroups) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH")
      console.error(
        `[dev] Could not send ${signal} to a child process: ${error.message}`,
      );
  }
}

function finishIfStopped() {
  if (stopping && children.size === 0) {
    clearTimeout(shutdownTimer);
    process.exit(exitCode);
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) signalChild(child, "SIGTERM");
  shutdownTimer = setTimeout(() => {
    for (const child of children) signalChild(child, "SIGKILL");
    process.exit(exitCode);
  }, 5000);
  finishIfStopped();
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

for (const { name, cwd, args, env } of launches) {
  console.log(`[dev] Starting ${name}`);
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
    detached: processGroups,
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`[dev] ${name} could not start: ${error.message}`);
    stop(1);
  });
  child.once("close", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(
        `[dev] ${name} exited (${signal ?? `code ${code}`}); stopping development stack.`,
      );
      stop(code && code > 0 ? code : 1);
    }
    finishIfStopped();
  });
}
