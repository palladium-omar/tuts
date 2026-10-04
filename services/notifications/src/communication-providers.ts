import nodemailer from "nodemailer";
import { z } from "zod";
import {
  assertDeliveryEnabled,
  CommunicationError,
  resolvePublicHost,
  safeJsonPost,
} from "./communication-security.js";
import { type Template } from "./communication-schemas.js";
export type DeliveryConnection = {
  provider: string;
  config: Record<string, any>;
  credentials: Record<string, string>;
};
export type Delivery = {
  id: string;
  address: string;
  subject: string;
  message: string;
  template: Template | null;
};
export function whatsappPayload(delivery: Delivery) {
  if (!delivery.template)
    throw new CommunicationError("An approved WhatsApp template is required");
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: delivery.address.replace(/^\+/, ""),
    type: "template",
    template: {
      name: delivery.template.name,
      language: { code: delivery.template.language },
      ...(delivery.template.parameters.length
        ? {
            components: [
              {
                type: "body",
                parameters: delivery.template.parameters.map((text) => ({
                  type: "text",
                  text,
                })),
              },
            ],
          }
        : {}),
    },
  };
}
export async function deliver(
  connection: DeliveryConnection,
  delivery: Delivery,
): Promise<string> {
  assertDeliveryEnabled();
  if (connection.provider === "smtp") {
    const selected = await resolvePublicHost(connection.config.host);
    const transport = nodemailer.createTransport({
      host: selected.address,
      port: connection.config.port,
      secure: connection.config.port === 465,
      requireTLS: true,
      auth: {
        user: connection.credentials.username,
        pass: connection.credentials.password,
      },
      tls: {
        servername: connection.config.host,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await Promise.race([
        transport.sendMail({
          from: {
            name: connection.config.fromName ?? "",
            address: connection.config.fromEmail,
          },
          to: delivery.address,
          subject: delivery.subject,
          text: delivery.message,
          messageId: `<${delivery.id}@tuts.invalid>`,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            transport.close();
            reject(
              new CommunicationError(
                "SMTP request timed out; acceptance is unknown",
                true,
              ),
            );
          }, 20000);
          timer.unref();
        }),
      ]);
      if (!info.accepted?.length)
        throw new CommunicationError("SMTP recipient was rejected");
      return info.messageId;
    } catch (e) {
      if (e instanceof CommunicationError) throw e;
      const error = e as {
        responseCode?: number;
        code?: string;
      };
      throw new CommunicationError(
        "SMTP request failed",
        !(
          error.responseCode &&
          error.responseCode >= 400 &&
          error.responseCode < 600
        ) && error.code !== "EAUTH",
      );
    } finally {
      if (timer) clearTimeout(timer);
      transport.close();
    }
  }
  if (connection.provider === "resend") {
    const from = connection.config.fromName
      ? `${connection.config.fromName} <${connection.config.fromEmail}>`
      : connection.config.fromEmail;
    const response = await safeJsonPost(
      "https://api.resend.com/emails",
      {
        from,
        to: [delivery.address],
        subject: delivery.subject,
        text: delivery.message,
      },
      {
        Authorization: `Bearer ${connection.credentials.apiKey}`,
        "Idempotency-Key": `tuts-recipient-${delivery.id}`,
      },
    );
    const parsed = z
      .object({ id: z.string().min(1).max(300) })
      .safeParse(response);
    if (!parsed.success)
      throw new CommunicationError(
        "Resend acceptance response could not be verified",
        true,
      );
    return parsed.data.id;
  }
  if (connection.provider === "whatsapp_business") {
    const response = await safeJsonPost(
      `https://graph.facebook.com/${connection.config.apiVersion}/${connection.config.phoneNumberId}/messages`,
      whatsappPayload(delivery),
      { Authorization: `Bearer ${connection.credentials.accessToken}` },
    );
    const parsed = z
      .object({
        messages: z.array(z.object({ id: z.string().min(1).max(500) })).min(1),
      })
      .safeParse(response);
    if (!parsed.success)
      throw new CommunicationError(
        "WhatsApp acceptance response could not be verified",
        true,
      );
    return parsed.data.messages[0]!.id;
  }
  throw new CommunicationError("This connection cannot deliver campaigns");
}
