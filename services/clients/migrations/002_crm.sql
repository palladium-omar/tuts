-- Add fields without changing names, existing identities, or payer relationships.
ALTER TABLE clients ADD COLUMN first_name text NOT NULL DEFAULT '' CHECK(length(first_name) <= 80);
ALTER TABLE clients ADD COLUMN last_name text NOT NULL DEFAULT '' CHECK(length(last_name) <= 80);
ALTER TABLE clients ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('lead','active','inactive'));
ALTER TABLE clients ALTER COLUMN status SET DEFAULT 'lead';
ALTER TABLE clients ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE clients ADD COLUMN source text CHECK(source IS NULL OR length(source) BETWEEN 1 AND 160);
CREATE INDEX clients_email_normalized_idx ON clients(business_id, lower(btrim(email))) WHERE email IS NOT NULL;
CREATE INDEX clients_status_idx ON clients(business_id, status, created_at DESC, id);
CREATE TABLE client_import_requests (
  business_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 160),
  digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, idempotency_key)
);
CREATE TABLE client_external_sources (
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 320),
  client_id uuid NOT NULL,
  source text NOT NULL CHECK(length(source) BETWEEN 1 AND 160),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, connection_id, external_id),
  FOREIGN KEY (business_id, client_id) REFERENCES clients(business_id, id) ON DELETE CASCADE
);
CREATE INDEX client_external_sources_client_idx ON client_external_sources(business_id, client_id);
ALTER TABLE client_import_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_import_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY client_import_requests_tenant ON client_import_requests
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
ALTER TABLE client_external_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_external_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY client_external_sources_tenant ON client_external_sources
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
