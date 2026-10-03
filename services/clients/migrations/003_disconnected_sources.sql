-- A disconnect persists independently of contact links so delayed broker batches
-- cannot resume intake. Existing CRM contacts and source mappings are retained.
CREATE TABLE disconnected_client_sources (
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  disconnected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, connection_id)
);
ALTER TABLE disconnected_client_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE disconnected_client_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY disconnected_client_sources_tenant ON disconnected_client_sources
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
