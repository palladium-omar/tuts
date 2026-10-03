import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Database } from '@palladium/service-kit';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class IdentityService {
  readonly auth: ReturnType<typeof betterAuth>;
  readonly gatewayUrl: string;
  readonly trustedOrigins: string[];
  private readonly internalSecret: string;

  constructor(@Inject(Database) database: Database) {
    const secret = process.env.BETTER_AUTH_SECRET;
    const internalSecret = process.env.PLATFORM_INTERNAL_SECRET;
    if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
    if (!internalSecret || internalSecret.length < 32) throw new Error('PLATFORM_INTERNAL_SECRET must contain at least 32 characters');
    this.internalSecret = internalSecret;
    this.gatewayUrl = new URL(process.env.PUBLIC_GATEWAY_URL || 'http://localhost:8080').origin;
    const appUrl = new URL(process.env.PUBLIC_APP_URL || 'http://localhost:3000').origin;
    if (process.env.NODE_ENV === 'production' && (!this.gatewayUrl.startsWith('https:') || !appUrl.startsWith('https:'))) {
      throw new Error('Production public URLs must use HTTPS');
    }
    this.trustedOrigins = [...new Set([appUrl, this.gatewayUrl])];
    const options: BetterAuthOptions = {
      appName: 'Tuts',
      secret,
      database: database.pool,
      baseURL: this.gatewayUrl,
      basePath: '/api/platform/auth',
      trustedOrigins: this.trustedOrigins,
      emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
      session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
      advanced: { defaultCookieAttributes: { path: '/', httpOnly: true, sameSite: 'lax' }, useSecureCookies: this.gatewayUrl.startsWith('https:') },
      rateLimit: { enabled: true, window: 60, max: 30 },
    };
    this.auth = betterAuth(options);
  }

  async requireSession(request: Request) {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new UnauthorizedException('A valid browser session is required');
    return session;
  }

  assertMutationOrigin(request: Request) {
    const origin = request.headers.origin;
    if (!origin || !this.trustedOrigins.includes(origin)) throw new ForbiddenException('A trusted Origin is required');
  }

  assertInternalSecret(request: Request) {
    const value = request.headers['x-platform-internal-secret'];
    const expected = Buffer.from(this.internalSecret);
    const supplied = Buffer.from(typeof value === 'string' ? value : '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new UnauthorizedException('Invalid internal authorization');
    }
  }
}
