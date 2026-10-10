import {
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  currentCloudflareBindings,
  Database,
  isCloudflareRuntime,
  logDiagnostic,
  registerBackgroundTask,
  serviceFetch,
} from "@palladium/service-kit";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { initialBusinessEntitlements } from "./schemas.js";
import type { RequestContext } from "@palladium/contracts";
import type { PoolClient } from "pg";
import { membershipPolicy, type MembershipPolicyRow } from "./membership-policy.js";

@Injectable()
export class IdentityService implements OnModuleInit {
  readonly auth: ReturnType<typeof betterAuth>;
  readonly gatewayUrl: string;
  readonly trustedOrigins: string[];
  readonly initialBusinessEntitlements: readonly string[];
  private readonly internalSecret: string;

  constructor(@Inject(Database) private readonly database: Database) {
    const secret = process.env.BETTER_AUTH_SECRET;
    const internalSecret = process.env.PLATFORM_INTERNAL_SECRET;
    if (!secret || secret.length < 32)
      throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
    if (!internalSecret || internalSecret.length < 32)
      throw new Error(
        "PLATFORM_INTERNAL_SECRET must contain at least 32 characters",
      );
    this.internalSecret = internalSecret;
    this.initialBusinessEntitlements = Object.freeze(
      initialBusinessEntitlements(),
    );
    this.gatewayUrl = new URL(
      process.env.PUBLIC_GATEWAY_URL || "http://localhost:8080",
    ).origin;
    const appUrl = new URL(
      process.env.PUBLIC_APP_URL || "http://localhost:3000",
    ).origin;
    if (
      process.env.NODE_ENV === "production" &&
      (!this.gatewayUrl.startsWith("https:") || !appUrl.startsWith("https:"))
    ) {
      throw new Error("Production public URLs must use HTTPS");
    }
    this.trustedOrigins = [...new Set([appUrl, this.gatewayUrl])];
    const options: BetterAuthOptions = {
      appName: "Tuts",
      secret,
      database: database.pool,
      baseURL: this.gatewayUrl,
      basePath: "/api/platform/auth",
      trustedOrigins: this.trustedOrigins,
      // Auth errors can contain request callback URLs. Keep credentials and
      // recovery links out of framework logs; delivery emits only a fixed message.
      logger: { disabled: true },
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        maxPasswordLength: 128,
        resetPasswordTokenExpiresIn: 30 * 60,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user, token }) => {
          try {
            this.assertAuthMailConfigured();
            const response = await serviceFetch(
              "notifications",
              "/internal/auth-mail/password-reset",
              {
                method: "POST",
                headers: this.authMailHeaders(),
                body: JSON.stringify({ recipientEmail: user.email, token }),
                signal: AbortSignal.timeout(15_000),
              },
            );
            if (!response.ok) throw new Error("Recovery delivery unavailable");
            const receipt = (await response.json()) as { accepted?: unknown };
            if (receipt?.accepted !== true)
              throw new Error("Recovery delivery unavailable");
          } catch (error) {
            // BetterAuth returns its generic success even if delivery fails.
            // Exposing failures only for existing users would disclose accounts.
            logDiagnostic('error', 'password_mail_failed', { error });
          }
        },
      },
      session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
      advanced: {
        // The runtime retains delivery promises and Worker invocation resources
        // after returning the account-neutral password-recovery response.
        backgroundTasks: { handler: registerBackgroundTask },
        // Public URL is deployment configuration, never forwarded host/protocol input.
        trustedProxyHeaders: false,
        // The private ingress must overwrite this header with the actual client IP.
        ipAddress: { ipAddressHeaders: ["x-real-ip"] },
        defaultCookieAttributes: { path: "/", httpOnly: true, sameSite: "lax" },
        useSecureCookies: this.gatewayUrl.startsWith("https:"),
      },
      rateLimit: {
        enabled: true,
        storage: "database",
        window: 60,
        max: 30,
        customRules: {
          "/request-password-reset": { window: 300, max: 3 },
          "/reset-password": { window: 300, max: 5 },
          "/reset-password/*": { window: 300, max: 5 },
        },
      },
    };
    this.auth = betterAuth(options);
  }

  async onModuleInit() {
    // The development starter tier is explicit; production grants require provisioning.
    if (process.env.NODE_ENV !== "development") return;
    const result = await this.database.pool.query<{ business_id: string }>(
      "SELECT DISTINCT business_id FROM identity_business_directory",
    );
    for (const row of result.rows)
      await this.database.withTenant(row.business_id, async (tx) => {
        await tx.query(
          "UPDATE businesses SET entitlements=array_append(entitlements,'integrations'),updated_at=now() WHERE business_id=$1 AND NOT ('integrations'=ANY(entitlements))",
          [row.business_id],
        );
      });
  }

  async requireSession(request: Request) {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session)
      throw new UnauthorizedException("A valid browser session is required");
    return session;
  }

  async requireBusinessContext(
    session: { user: { id: string } },
    businessId: string,
    transaction?: PoolClient,
  ) {
    const resolve = async (tx: PoolClient) => {
      const result = await tx.query<MembershipPolicyRow & { entitlements: string[] }>(
        "SELECT m.role,m.permissions_override,m.access_scope,b.entitlements FROM memberships m JOIN businesses b USING (business_id) WHERE m.user_id=$1",
        [session.user.id],
      );
      const membership = result.rows[0];
      if (!membership)
        throw new ForbiddenException("Business membership is required");
      const policy = await membershipPolicy(tx, session.user.id, membership);
      return {
        sub: session.user.id,
        businessId,
        role: membership.role,
        entitlements: membership.entitlements,
        ...policy,
      } satisfies Omit<RequestContext, "requestId">;
    };
    return transaction ? resolve(transaction) : this.database.withTenant(businessId, resolve);
  }

  assertMutationOrigin(request: Request) {
    const origin = request.headers.origin;
    if (!origin || !this.trustedOrigins.includes(origin))
      throw new ForbiddenException("A trusted Origin is required");
  }

  private authMailHeaders() {
    return {
      "Content-Type": "application/json",
      "X-Auth-Mail-Secret": process.env.AUTH_MAIL_INTERNAL_SECRET || "",
    };
  }

  private assertAuthMailConfigured() {
    const secret = process.env.AUTH_MAIL_INTERNAL_SECRET;
    const binding = currentCloudflareBindings()?.NOTIFICATIONS as
      | { fetch?: unknown }
      | undefined;
    const transportConfigured = isCloudflareRuntime()
      ? typeof binding?.fetch === "function"
      : Boolean(process.env.NOTIFICATIONS_URL);
    if (
      process.env.AUTH_MAIL_ENABLED !== "true" ||
      !secret ||
      !/^[A-Za-z0-9_+/=-]{32,512}$/.test(secret) ||
      !transportConfigured
    ) {
      logDiagnostic("error", "password_mail_not_configured", { status: 503 });
      throw new ServiceUnavailableException("Password recovery is temporarily unavailable");
    }
  }

  async assertPasswordRecoveryAvailable() {
    // Run before email validation/account lookup, including unknown addresses.
    this.assertAuthMailConfigured();
    try {
      const response = await serviceFetch(
        "notifications",
        "/internal/auth-mail/status",
        {
          method: "GET",
          headers: this.authMailHeaders(),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error("Recovery delivery unavailable");
      const status = (await response.json()) as { available?: unknown };
      if (status?.available !== true)
        throw new Error("Recovery delivery unavailable");
    } catch {
      throw new ServiceUnavailableException("Password recovery is temporarily unavailable");
    }
  }

  assertInternalSecret(request: Request) {
    const value = request.headers["x-platform-internal-secret"];
    const expected = Buffer.from(this.internalSecret);
    const supplied = Buffer.from(typeof value === "string" ? value : "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new UnauthorizedException("Invalid internal authorization");
    }
  }
}
