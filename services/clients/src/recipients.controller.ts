import { Body, Controller, Inject, Post } from "@nestjs/common";
import type { RequestContext } from "@palladium/contracts";
import {
  CurrentContext,
  Database,
  Roles,
  Permissions,
  parseBody,
} from "@palladium/service-kit";
import { recipientRequestSchema } from "./schemas.js";
import { buildClientQuery } from "./client-query.js";
import { item, type ClientRow } from "./contact-store.js";

@Roles("owner", "admin", "tutor")
@Controller("v1/recipients")
export class RecipientsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Post()
  @Permissions("clients.write")
  async resolve(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const input = parseBody(recipientRequestSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const query = input.clientIds
        ? {
            where: "merged_into IS NULL AND id=ANY($1::uuid[])",
            order: "id ASC",
            values: [[...new Set(input.clientIds)]] as unknown[],
            countValues: [[...new Set(input.clientIds)]] as unknown[],
          }
        : await buildClientQuery(tx, input.filter!);
      const count = await tx.query<{ total: string }>(
        `SELECT count(*) AS total FROM clients WHERE ${query.where}`,
        query.countValues,
      );
      const result = await tx.query<ClientRow>(
        `SELECT * FROM clients WHERE ${query.where} ORDER BY ${query.order} LIMIT 2000`,
        query.values,
      );
      const total = Number(count.rows[0]!.total);
      return {
        items: result.rows.map((row) => {
          const contact = item(row);
          return {
            id: contact.id,
            displayName: contact.displayName,
            firstName: contact.firstName,
            lastName: contact.lastName,
            email: contact.email,
            phone: contact.phone,
            emailOptIn: contact.emailOptIn,
            whatsappOptIn: contact.whatsappOptIn,
            customFields: contact.customFields,
          };
        }),
        total,
        truncated: total > result.rows.length,
      };
    });
  }
}
