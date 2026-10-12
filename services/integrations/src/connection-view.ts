import type { Config, Provider } from "./schemas.js";

export type ConnectionRow = {
  id: string;
  business_id: string;
  created_by: string;
  provider: Provider;
  display_name: string;
  credentials_encrypted: string | null;
  webhook_secret_hash: string | null;
  cal_webhook_secret_encrypted: string | null;
  config: Config;
  account: Record<string, unknown>;
  status: string;
  last_sync_at: Date | null;
  last_attempt_at: Date | null;
  last_error: string | null;
  next_sync_at: Date | null;
  sync_counts: Record<string, unknown>;
  last_import_result: Record<string, unknown> | null;
  dispatch_entitlements: string[];
  created_at: Date;
  updated_at: Date;
};
export function connectionView(row: ConnectionRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    ownerUserId: row.created_by,
    provider: row.provider,
    ...(row.provider === 'google_calendar' ? {authMode: row.account.authMode === 'ical' ? 'ical' : 'oauth'} : {}),
    displayName: row.display_name,
    config: row.config,
    account: row.account,
    status: row.status,
    lastSyncAt: row.last_sync_at?.toISOString() ?? null,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastError: row.last_error,
    nextSyncAt: row.next_sync_at?.toISOString() ?? null,
    syncCounts: row.sync_counts,
    lastImportResult: row.last_import_result,
    dispatchEntitlements: row.dispatch_entitlements,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    calWebhookConfigured: Boolean(row.cal_webhook_secret_encrypted),
    ...(row.provider === 'calcom' && row.cal_webhook_secret_encrypted
      ? {webhookPath: `/api/integrations/hooks/${row.business_id}/${row.id}`} : {}),
    ...(row.provider === "form_webhook"
      ? { webhookPath: `/api/integrations/hooks/${row.business_id}/${row.id}` }
      : {}),
  };
}
