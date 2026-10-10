import { z } from "zod";
export { permissionNames, defaultPermissions, hasPermission, canAccessStudent, canReadFinancial } from './permissions.js';
export type { Permission, PermissionSubject } from './permissions.js';
export const serviceNames = [
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
  permissions: z.array(z.string().regex(/^[a-z]+\.[a-z.]+$/)).max(100).optional(),
  accessScope: z.enum(['business', 'students']).optional(),
  studentIds: z.array(z.uuid()).max(500).optional(),
  policyVersion: z.literal(1).optional(),
}).superRefine((context, validation) => {
  if (context.policyVersion === 1 &&
      (context.permissions === undefined || context.accessScope === undefined || context.studentIds === undefined)) {
    validation.addIssue({ code: 'custom', message: 'Versioned policy context requires complete permissions and resource scope' });
  }
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
      "clients.student-merged.v1",
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
      "clients.student-merged.v1",
      "integrations.sessions-synced.v1",
      "integrations.connection-disconnected.v1",
    ],
  },
  { consumer: "planning", types: ["clients.student-merged.v1"] },
  { consumer: "reporting", types: [
    "scheduling.class-updated.v1", "learning.assignment-created.v1", "learning.assignment-submitted.v1",
    "learning.assignment-reviewed.v1", "learning.assignment-updated.v1", "learning.resource-created.v1",
    "learning.resource-updated.v1", "billing.invoice-updated.v1", "clients.student-merged.v1",
  ] },
  { consumer: "learning", types: ["clients.student-merged.v1"] },
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
    id: 'tracker',
    label: 'Student tracker',
    path: '/students',
    entitlement: 'clients',
    permission: 'clients.read',
    apiPrefix: '/api/clients',
  },
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
  { id: "planning", label: "Student boards", path: "/boards", entitlement: "planning", dependencies: ["clients"], apiPrefix: "/api/planning" },
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
