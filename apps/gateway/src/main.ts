import express, { type Request } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { requestContextSchema, serviceNames } from "@palladium/contracts";
const app = express();
app.disable("x-powered-by");
const appOrigin = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
const gatewayOrigin = process.env.PUBLIC_GATEWAY_URL ?? "http://localhost:8080";
const serviceUrls = Object.fromEntries(
  serviceNames.map((name, i) => [
    name,
    process.env[`${name.toUpperCase()}_URL`] ?? `http://localhost:${4001 + i}`,
  ]),
);
const privateKey = await importPKCS8(
  (process.env.CONTEXT_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  "EdDSA",
);
if (!process.env.PLATFORM_INTERNAL_SECRET)
  throw new Error("PLATFORM_INTERNAL_SECRET required");
const tokens = new WeakMap<Request, string>();
// Form providers authenticate with a connector-scoped secret, not browser cookies.
app.use(
  "/api/integrations/hooks",
  express.json({ limit: "1mb" }),
  createProxyMiddleware({
    target: serviceUrls.integrations,
    pathRewrite: (path) => `/hooks${path}`,
    changeOrigin: false,
    on: {
      proxyReq(proxyReq, req) {
        fixRequestBody(proxyReq, req);
        proxyReq.removeHeader("cookie");
        proxyReq.removeHeader("x-platform-internal-secret");
        proxyReq.removeHeader("x-auth-mail-secret");
        proxyReq.removeHeader("x-portal-internal-secret");
        proxyReq.removeHeader("x-business-id");
      },
      error(_error, _req, res) {
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: "service_unavailable",
                message: "Connector service is unavailable",
              },
            }),
          );
        }
      },
    },
  }),
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ![appOrigin, gatewayOrigin].includes(origin)) {
    res
      .status(403)
      .json({
        error: { code: "origin_denied", message: "Origin not permitted" },
      });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Business-Id, Idempotency-Key",
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  // Cookie sessions require a trusted browser Origin on state-changing requests.
  if (!["GET", "HEAD"].includes(req.method) && !origin) {
    res
      .status(403)
      .json({
        error: {
          code: "origin_required",
          message: "A trusted Origin header is required",
        },
      });
    return;
  }
  next();
});
app.get("/health", (_req, res) =>
  res.json({ service: "gateway", status: "ok" }),
);
for (const name of serviceNames) {
  const prefix = `/api/${name}`;
  const proxy = createProxyMiddleware({
    target: serviceUrls[name],
    changeOrigin: false,
    on: {
      proxyReq(proxyReq, req) {
        proxyReq.removeHeader("authorization");
        proxyReq.removeHeader("x-platform-internal-secret");
        proxyReq.removeHeader("x-auth-mail-secret");
        proxyReq.removeHeader("x-user-id");
        proxyReq.removeHeader("x-role");
        const token = tokens.get(req as Request);
        if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
      },
      error(_err, _req, res) {
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: "service_unavailable",
                message: `${name} service is unavailable`,
              },
            }),
          );
        }
      },
    },
  });
  app.use(
    prefix,
    async (req, res, next) => {
      if (
        !req.path.startsWith("/v1/") &&
        !(name === "platform" && req.path.startsWith("/auth/"))
      ) {
        res
          .status(404)
          .json({
            error: { code: "route_not_found", message: "Unknown API route" },
          });
        return;
      }
      if (name === "platform") {
        next();
        return;
      }
      const businessId = req.headers["x-business-id"];
      if (typeof businessId !== "string") {
        res
          .status(400)
          .json({
            error: { code: "business_required", message: "Select a business" },
          });
        return;
      }
      try {
        const contextResponse = await fetch(
          `${serviceUrls.platform}/internal/context`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: req.headers.cookie ?? "",
              "x-platform-internal-secret":
                process.env.PLATFORM_INTERNAL_SECRET!,
            },
            body: JSON.stringify({ businessId }),
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!contextResponse.ok) {
          res.status(contextResponse.status).json(await contextResponse.json());
          return;
        }
        const { item } = (await contextResponse.json()) as any;
        const context = requestContextSchema.parse({
          ...item,
          requestId: randomUUID(),
        });
        if (!context.entitlements.includes(name)) {
          res
            .status(403)
            .json({
              error: {
                code: "feature_disabled",
                message: "Feature is not enabled for this business",
              },
            });
          return;
        }
        const token = await new SignJWT(context)
          .setProtectedHeader({ alg: "EdDSA" })
          .setIssuer("palladium-gateway")
          .setAudience("palladium-services")
          .setIssuedAt()
          .setExpirationTime("60s")
          .sign(privateKey);
        tokens.set(req, token);
        next();
      } catch {
        res
          .status(503)
          .json({
            error: {
              code: "identity_unavailable",
              message: "Business access could not be verified",
            },
          });
      }
    },
    proxy,
  );
}
app.use((_req, res) =>
  res
    .status(404)
    .json({ error: { code: "route_not_found", message: "Unknown route" } }),
);
app.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () =>
  console.log("Tuts gateway listening"),
);
