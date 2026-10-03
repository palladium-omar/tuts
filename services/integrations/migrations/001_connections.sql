-- Service-owned discovery directory contains tenant keys only, no credentials or records.
CREATE TABLE integration_tenant_directory (business_id uuid PRIMARY KEY);
CREATE TABLE integration_connections (
  id uuid PRIMARY KEY, business_id uuid NOT NULL, created_by text NOT NULL,
  provider text NOT NULL CHECK(provider IN ('calendly','calcom','json_api','form_webhook')),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
  credentials_encrypted text, webhook_secret_hash text, config jsonb NOT NULL,
  account jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK(status IN ('connected','error','disconnected')),
  last_sync_at timestamptz, last_attempt_at timestamptz, last_error text,
  next_sync_at timestamptz, sync_counts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_connections_due ON integration_connections(business_id,next_sync_at) WHERE status <> 'disconnected';
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_connections_tenant ON integration_connections
 USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
 WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
