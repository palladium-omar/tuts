import { createHash, timingSafeEqual } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public, logDiagnostic } from "@palladium/service-kit";
import { z } from "zod";
import {
  AuthMailDeliveryError,
  type AuthMailProvider,
  ResendAuthMailProvider,
} from "./auth-mail-providers.js";

const emailSchema = z.string().min(3).max(254).email();
const passwordResetSchema = z.object({
  recipientEmail: emailSchema,
  token: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const portalInvitationSchema = z.object({
  recipientEmail: emailSchema,
  token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
  businessId: z.uuid(), invitationId: z.uuid(),
  deliveryRevision: z.number().int().positive().max(1_000_000),
}).strict();
const boundedSecret = /^[A-Za-z0-9+/_=-]{32,512}$/;

function assertInternalSecret(supplied: unknown): void {
  const expected = process.env.AUTH_MAIL_INTERNAL_SECRET ?? "";
  if (
    typeof supplied !== "string" || !boundedSecret.test(supplied) ||
    !boundedSecret.test(expected)
  ) throw new UnauthorizedException("Internal authorization required");
  // Digesting both values keeps timingSafeEqual inputs at a fixed size even
  // when the caller supplies a secret of a different length.
  const actualHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(actualHash, expectedHash))
    throw new UnauthorizedException("Internal authorization required");
}

function senderIsValid(sender: string): boolean {
  if (sender.length > 340 || /[\r\n\x00-\x1f\x7f]/.test(sender)) return false;
  if (emailSchema.safeParse(sender).success) return true;
  const formatted = /^([^<>]{1,80}) <([^<>]+)>$/.exec(sender);
  return Boolean(formatted && emailSchema.safeParse(formatted[2]).success);
}

function configuration(): { provider: AuthMailProvider; appOrigin: string } | null {
  if (
    process.env.AUTH_MAIL_PROVIDER !== "resend" ||
    !boundedSecret.test(process.env.AUTH_MAIL_INTERNAL_SECRET ?? "")
  ) return null;
  const from = process.env.AUTH_MAIL_FROM ?? "";
  const apiKey = process.env.AUTH_MAIL_API_KEY ?? "";
  if (!senderIsValid(from) || !/^[\x21-\x7e]{16,512}$/.test(apiKey)) return null;
  try {
    const app = new URL(process.env.PUBLIC_APP_URL ?? "");
    if (
      app.protocol !== "https:" || app.username || app.password ||
      app.pathname !== "/" || app.search || app.hash ||
      (app.port && app.port !== "443")
    ) return null;
    return { provider: new ResendAuthMailProvider(from, apiKey), appOrigin: app.origin };
  } catch {
    return null;
  }
}

@Injectable()
export class AuthMailService {
  status() {
    const enabled = process.env.AUTH_MAIL_ENABLED === "true";
    const config = configuration();
    return { enabled, available: enabled && Boolean(config), provider: config ? "resend" : null };
  }

  async sendPasswordReset(input: unknown) {
    const parsed = passwordResetSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid password reset email request");
    const config = configuration();
    if (process.env.AUTH_MAIL_ENABLED !== "true" || !config)
      throw new ServiceUnavailableException("Password reset email is unavailable");
    const { recipientEmail, token } = parsed.data;
    const resetUrl = `${config.appOrigin}/reset-password#token=${encodeURIComponent(token)}`;
    try {
      const messageId = await config.provider.sendPasswordReset({ recipientEmail, token, resetUrl });
      if (!messageId) throw new AuthMailDeliveryError();
      return { accepted: true, messageId };
    } catch (error) {
      logDiagnostic('error', 'auth_mail_provider_failed', {
        error,
        failureCategory: error instanceof AuthMailDeliveryError ? error.category : 'invalid_response',
        providerStatus: error instanceof AuthMailDeliveryError ? error.providerStatus : undefined,
      });
      throw new BadGatewayException("Password reset email could not be accepted");
    }
  }

  async sendPortalInvitation(input: unknown) {
    const parsed = portalInvitationSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid portal invitation email request');
    const config = configuration();
    if (process.env.AUTH_MAIL_ENABLED !== 'true' || !config)
      throw new ServiceUnavailableException('Portal invitation email is unavailable');
    const {recipientEmail, token, businessId, invitationId, deliveryRevision} = parsed.data;
    // Link origin and path are configured here, never supplied by the caller.
    const inviteUrl = `${config.appOrigin}/portal/invite#token=${encodeURIComponent(token)}&business=${encodeURIComponent(businessId)}`;
    try {
      const messageId = await config.provider.sendPortalInvitation({recipientEmail, invitationId, deliveryRevision, inviteUrl});
      if (!messageId) throw new AuthMailDeliveryError();
      return {accepted: true, messageId};
    } catch (error) {
      logDiagnostic('error', 'auth_mail_provider_failed', {
        error,
        failureCategory: error instanceof AuthMailDeliveryError ? error.category : 'invalid_response',
        providerStatus: error instanceof AuthMailDeliveryError ? error.providerStatus : undefined,
      });
      throw new BadGatewayException('Portal invitation email could not be accepted');
    }
  }
}

/** Public bypasses tenant JWTs; the controller still requires its own secret. */
@Public()
@ApiExcludeController()
@Controller("internal/auth-mail")
export class AuthMailController {
  constructor(@Inject(AuthMailService) private readonly mail: AuthMailService) {}

  @Get("status")
  status(@Headers("x-auth-mail-secret") secret: unknown) {
    assertInternalSecret(secret);
    return this.mail.status();
  }

  @Post("password-reset")
  @HttpCode(200)
  sendPasswordReset(
    @Headers("x-auth-mail-secret") secret: unknown,
    @Body() body: unknown,
    @Req() request: { headers: Record<string, unknown>; rawBody?: Buffer },
  ) {
    assertInternalSecret(secret);
    if (
      typeof request.headers["content-type"] !== "string" ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"]) ||
      (request.rawBody && request.rawBody.byteLength > 2048)
    ) throw new BadRequestException("Invalid password reset email request");
    return this.mail.sendPasswordReset(body);
  }

  @Post('portal-invitation')
  @HttpCode(200)
  sendPortalInvitation(
    @Headers('x-auth-mail-secret') secret: unknown,
    @Body() body: unknown,
    @Req() request: {headers: Record<string, unknown>; rawBody?: Buffer},
  ) {
    assertInternalSecret(secret);
    if (typeof request.headers['content-type'] !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']) ||
      (request.rawBody && request.rawBody.byteLength > 2048))
      throw new BadRequestException('Invalid portal invitation email request');
    return this.mail.sendPortalInvitation(body);
  }
}
