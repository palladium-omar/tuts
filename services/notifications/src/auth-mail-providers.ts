import { createHash } from "node:crypto";

/** System identity mail is independent of business communications providers. */
export interface PasswordResetMail {
  recipientEmail: string;
  token: string;
  resetUrl: string;
}

export interface AuthMailProvider {
  sendPasswordReset(mail: PasswordResetMail): Promise<string>;
}

export class AuthMailDeliveryError extends Error {
  constructor(readonly retryable = false) {
    super("Password reset email could not be accepted");
    this.name = "AuthMailDeliveryError";
  }
}

const responseLimit = 16 * 1024;
const providerTimeoutMs = 5_000;

/** Fixed origin, bounded response and deadline; never surface provider content. */
export class ResendAuthMailProvider implements AuthMailProvider {
  constructor(
    private readonly from: string,
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async sendPasswordReset(mail: PasswordResetMail): Promise<string> {
    const idempotencyKey = createHash("sha256")
      .update(JSON.stringify([mail.recipientEmail, mail.token]))
      .digest("hex");
    const deadline = AbortSignal.timeout(12_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.sendAttempt(mail, idempotencyKey, deadline);
      } catch (error) {
        if (
          !(error instanceof AuthMailDeliveryError) || !error.retryable ||
          attempt === 1 || deadline.aborted
        ) throw new AuthMailDeliveryError();
        // Repeat the same token only, under the same provider idempotency key.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new AuthMailDeliveryError();
  }

  private async sendAttempt(
    mail: PasswordResetMail,
    idempotencyKey: string,
    deadline: AbortSignal,
  ): Promise<string> {
    try {
      const response = await this.transport("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Idempotency-Key": `tuts-password-reset-${idempotencyKey}`,
        },
        body: JSON.stringify({
          from: this.from,
          to: [mail.recipientEmail],
          subject: "Reset your Tuts password",
          text: [
            "A password reset was requested for your Tuts account.",
            "",
            "Use this link to choose a new password:",
            mail.resetUrl,
            "",
            "This link expires in 30 minutes.",
            "If you did not request this, you can ignore this email.",
          ].join("\n"),
        }),
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(providerTimeoutMs)]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AuthMailDeliveryError(
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > responseLimit) {
            await reader.cancel();
            throw new AuthMailDeliveryError();
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      let result: unknown;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new AuthMailDeliveryError(); }
      if (
        !result || typeof result !== "object" || !("id" in result) ||
        typeof result.id !== "string" || result.id.length > 300 ||
        !/^[A-Za-z0-9_-]+$/.test(result.id)
      ) throw new AuthMailDeliveryError();
      return result.id;
    } catch (error) {
      if (error instanceof AuthMailDeliveryError) throw error;
      // A network failure may follow acceptance; repeating this token uses the
      // same key so the provider can return the first accepted message.
      throw new AuthMailDeliveryError(true);
    }
  }
}
