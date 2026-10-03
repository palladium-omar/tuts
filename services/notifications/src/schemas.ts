import { z } from 'zod';
export const uuid=z.string().uuid();
export const notificationSchema=z.object({title:z.string().trim().min(1).max(200),message:z.string().trim().min(1).max(5000),channel:z.enum(['in_app','email']).default('in_app'),recipientClientId:uuid.optional()}).strict();
export const listSchema=z.object({status:z.enum(['queued','read','cancelled']).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).strict();
export const statusSchema=z.object({status:z.enum(['read','cancelled'])}).strict();
export const eventPayloadSchemas = {
 'clients.client-created.v1':z.object({clientId:uuid}),
 'scheduling.session-created.v1':z.object({sessionId:uuid,clientId:uuid,startsAt:z.string().datetime()}),
 'scheduling.session-completed.v1':z.object({sessionId:uuid,clientId:uuid}),
 'learning.assignment-created.v1':z.object({assignmentId:uuid,clientId:uuid,dueAt:z.string().datetime().nullable()}),
 'billing.invoice-issued.v1':z.object({invoiceId:uuid,amountMinor:z.number().int().positive(),currency:z.string().regex(/^[A-Z]{3}$/)}),
 'payments.payment-confirmed.v1':z.object({paymentId:uuid,invoiceId:uuid,amountMinor:z.number().int().positive(),currency:z.string().regex(/^[A-Z]{3}$/),provider:z.string().min(1).max(40)}),
} as const;
export type NotificationEventType=keyof typeof eventPayloadSchemas;
export function notificationIntent(type:NotificationEventType,input:unknown) {
 const data=eventPayloadSchemas[type].parse(input);
 const titles:Record<NotificationEventType,string>={
  'clients.client-created.v1':'Student record created',
  'scheduling.session-created.v1':'Session scheduled',
  'scheduling.session-completed.v1':'Session completed',
  'learning.assignment-created.v1':'Assignment created',
  'billing.invoice-issued.v1':'Invoice issued',
  'payments.payment-confirmed.v1':'Payment confirmed',
 };
 const clientId='clientId' in data ? data.clientId:null;
 const title = type === 'payments.payment-confirmed.v1' && 'provider' in data && data.provider === 'sandbox' ? 'Sandbox payment confirmed (simulated)' : titles[type];
 return {title,message:title,recipientClientId:clientId,metadata:data};
}
