import { ConflictException, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const invoiceSchema = z.object({
  payerName: z.string().trim().min(1).max(200),
  clientId: z.string().uuid().optional(),
  currency: currencySchema,
  items: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().int().positive().max(1000000),
    unitPriceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(100),
}).strict();
export type InvoiceInput = z.infer<typeof invoiceSchema>;
export function totalMinor(items: InvoiceInput['items']): number {
  const total = items.reduce((sum, item) => sum + BigInt(item.quantity) * BigInt(item.unitPriceMinor), 0n);
  if (total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new BadRequestException('invoice_total_invalid');
  return Number(total);
}
export const paymentSchema = z.object({paymentId:z.string().uuid(), invoiceId:z.string().uuid(), amountMinor:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency:currencySchema,provider:z.string().min(1).max(40)});
export function allocatePayment(invoice:{status:string;currency:string;totalMinor:number;paidMinor:number}, payment:{currency:string;amountMinor:number}) {
  if (invoice.status === 'draft') throw new ConflictException('invoice_not_issued');
  if (invoice.currency !== payment.currency) throw new ConflictException('payment_currency_mismatch');
  const paid = BigInt(invoice.paidMinor) + BigInt(payment.amountMinor);
  if (paid > BigInt(invoice.totalMinor)) throw new ConflictException('payment_exceeds_amount_due');
  return {paidMinor:Number(paid),status:paid === BigInt(invoice.totalMinor) ? 'settled' : 'issued'};
}
