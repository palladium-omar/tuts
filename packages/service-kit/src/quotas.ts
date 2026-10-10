import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Database } from './database.js';
import { OPTIONS, type ServiceOptions } from './auth.js';
import type { RequestContext } from '@palladium/contracts';

/** Route classification uses controller paths, not arbitrary client query values. */
export function expensiveRequestClass(service: string, method: string, path: string): 'reporting' | 'mutation' | 'ingestion' | undefined {
  if (service === 'reporting' && !['HEAD', 'OPTIONS'].includes(method)) return 'reporting';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return undefined;
  if (/(?:^|\/)(?:hooks|webhooks|calcom-webhook|ingestion)(?:\/|$)/.test(path)) return 'ingestion';
  if (/(?:^|\/)(?:imports|history-imports|upload|submission-upload|reconcile|sync|client-diagnostics)(?:\/|$)/.test(path)) return 'mutation';
  return undefined;
}

@Injectable()
export class ExpensiveRequestGuard implements CanActivate {
  constructor(@Inject(Database) private readonly db: Database, @Inject(OPTIONS) private readonly options: ServiceOptions) {}
  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const req = execution.switchToHttp().getRequest();
    const category = expensiveRequestClass(this.options.name, req.method, req.path ?? '');
    if (!category) return true;
    const context = req.context as RequestContext | undefined;
    // Public ingestion has a service-wide budget. Never trust tenant/IP headers
    // as identities; only verified signed contexts can create actor budgets.
    const scopes: [string, number][] = context ? [
      [`${category}:tenant:${context.businessId}`, category === 'reporting' ? 300 : 60],
      [`${category}:actor:${context.businessId}:${context.sub}`, category === 'reporting' ? 120 : 20],
    ] : [[`${category}:public`, 120]];
    try {
      await this.db.transaction(async tx => {
        // Stable ordering avoids deadlocks when requests share a tenant budget.
        for (const [scope, limit] of scopes.sort(([a], [b]) => a.localeCompare(b))) {
          const result = await tx.query(`INSERT INTO service_request_budgets(scope,window_start,used)
            VALUES($1,date_trunc('minute',now()),1)
            ON CONFLICT(scope,window_start) DO UPDATE SET used=service_request_budgets.used+1
            WHERE service_request_budgets.used < $2 RETURNING used`, [scope, limit]);
          if (!result.rowCount) throw new HttpException({ code: 'request_quota_exceeded', message: 'Request budget exceeded; retry after one minute' }, 429);
        }
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429) execution.switchToHttp().getResponse().setHeader('Retry-After', '60');
      throw error;
    }
    return true;
  }
}
