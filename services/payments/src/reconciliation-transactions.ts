import { Controller, ForbiddenException, Get, Inject, Injectable, Query } from '@nestjs/common';
import { CurrentContext, Database, Permissions, Roles, assertPermission, parseBody } from '@palladium/service-kit';
import { confirmedReceiptsResponseSchema, type RequestContext } from '@palladium/contracts';
import { z } from 'zod';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();

@Injectable()
export class ReconciliationTransactionsService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async list(ctx: RequestContext, query: unknown) {
    if (!['owner', 'admin', 'tutor'].includes(ctx.role) || ctx.accessScope === 'students')
      throw new ForbiddenException('Business financial access required');
    assertPermission(ctx, 'payments.read');
    assertPermission(ctx, 'reporting.financial');
    if (!ctx.entitlements.includes('payments')) throw new ForbiddenException('Payments is not enabled');
    const input = parseBody(querySchema, query);
    return this.db.withTenant(ctx.businessId, async tx => {
      const count = (await tx.query("SELECT count(*) total FROM payment_attempts WHERE status='confirmed'")).rows[0];
      // Credentials, provider payloads and customer contact details never leave
      // Payments. Stable provider identity and payment ID permit safe recovery.
      const { rows } = await tx.query(`SELECT id,invoice_id,connection_id,provider,provider_reference,amount_minor,currency,confirmed_at,simulated
        FROM payment_attempts WHERE status='confirmed'
        ORDER BY confirmed_at,id LIMIT $1 OFFSET $2`, [input.limit, input.offset]);
      return parseBody(confirmedReceiptsResponseSchema, {
        items: rows.map(row => ({ paymentId: row.id, invoiceId: row.invoice_id, connectionId: row.connection_id,
          provider: row.provider, providerReference: row.provider_reference, amountMinor: Number(row.amount_minor),
          currency: row.currency, confirmedAt: row.confirmed_at.toISOString(), simulated: row.simulated })),
        total: Number(count.total), ...input,
      });
    }, { isolation: 'repeatable read' });
  }
}

@Controller('v1/reconciliation/transactions')
@Roles('owner', 'admin', 'tutor')
@Permissions('payments.read', 'reporting.financial')
export class ReconciliationTransactionsController {
  constructor(@Inject(ReconciliationTransactionsService) private readonly service: ReconciliationTransactionsService) {}
  @Get()
  list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) { return this.service.list(ctx, query); }
}
