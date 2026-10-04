import { z } from "zod";
export const serviceNames = [
  "platform",
  "clients",
  "scheduling",
  "learning",
  "billing",
  "payments",
  "notifications",
  "integrations",
] as const;
export const featureNames = serviceNames.filter((name) => name !== "platform");
export const roleSchema = z.enum([
  "owner",
  "admin",
  "tutor",
  "student",
  "parent",
]);
export const requestContextSchema = z.object({
  sub: z.string().min(1),
  businessId: z.uuid(),
  role: roleSchema,
  entitlements: z.array(z.string()),
  requestId: z.string().min(1),
});
export type RequestContext = z.infer<typeof requestContextSchema>;
export const platformEventSchema = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[a-z]+\.[a-z-]+\.v\d+$/),
  version: z.literal(1),
  producer: z.enum(serviceNames),
  businessId: z.uuid(),
  occurredAt: z.iso.datetime(),
  correlationId: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type PlatformEvent = z.infer<typeof platformEventSchema>;
// Durable broker routing is part of the wire contract. Producers declare these
// bindings before publishing, including when the consuming process is offline.
export const eventConsumerSubscriptions = [
  {
    consumer: "billing",
    types: [
      "payments.payment-confirmed.v1",
      "platform.business-profile-updated.v1",
      "scheduling.class-updated.v1",
    ],
  },
  { consumer: "integrations", types: ["clients.source-synced.v1"] },
  {
    consumer: "clients",
    types: [
      "integrations.contacts-received.v1",
      "integrations.connection-disconnected.v1",
    ],
  },
  {
    consumer: "scheduling",
    types: [
      "integrations.sessions-synced.v1",
      "integrations.connection-disconnected.v1",
    ],
  },
  { consumer: "payments", types: ["billing.invoice-issued.v1"] },
  {
    consumer: "notifications",
    types: [
      "clients.client-created.v1",
      "clients.client-updated.v1",
      "scheduling.session-created.v1",
      "scheduling.session-completed.v1",
      "learning.assignment-created.v1",
      "billing.invoice-issued.v1",
      "payments.payment-confirmed.v1",
    ],
  },
] as const satisfies readonly {
  consumer: (typeof serviceNames)[number];
  types: readonly string[];
}[];

export const featureRegistry = [
  {
    id: "clients",
    label: "CRM",
    path: "/clients",
    entitlement: "clients",
    apiPrefix: "/api/clients",
  },
  {
    id: "scheduling",
    label: "Sessions",
    path: "/sessions",
    entitlement: "scheduling",
    apiPrefix: "/api/scheduling",
  },
  {
    id: "learning",
    label: "Learning",
    path: "/learning",
    entitlement: "learning",
    apiPrefix: "/api/learning",
  },
  {
    id: "billing",
    label: "Invoices",
    path: "/invoices",
    entitlement: "billing",
    apiPrefix: "/api/billing",
  },
  {
    id: "payments",
    label: "Payments",
    path: "/payments",
    entitlement: "payments",
    apiPrefix: "/api/payments",
  },
  {
    id: "integrations",
    label: "Connectors",
    path: "/connectors",
    entitlement: "integrations",
    apiPrefix: "/api/integrations",
  },
  {
    id: "notifications",
    label: "Activity",
    path: "/activity",
    entitlement: "notifications",
    apiPrefix: "/api/notifications",
  },
] as const;
