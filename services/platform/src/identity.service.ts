import {
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { Database } from "@palladium/service-kit";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { initialBusinessEntitlements } from "./schemas.js";

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
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        maxPasswordLength: 128,
      },
      session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
      advanced: {
        // Public URL is deployment configuration, never forwarded host/protocol input.
        trustedProxyHeaders: false,
        // The private ingress must overwrite this header with the actual client IP.
        ipAddress: { ipAddressHeaders: ["x-real-ip"] },
        defaultCookieAttributes: { path: "/", httpOnly: true, sameSite: "lax" },
        useSecureCookies: this.gatewayUrl.startsWith("https:"),
      },
      rateLimit: { enabled: true, window: 60, max: 30 },
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

  assertMutationOrigin(request: Request) {
    const origin = request.headers.origin;
    if (!origin || !this.trustedOrigins.includes(origin))
      throw new ForbiddenException("A trusted Origin is required");
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
