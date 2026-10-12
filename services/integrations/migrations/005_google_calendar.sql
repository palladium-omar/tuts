ALTER TABLE integration_connections DROP CONSTRAINT integration_connections_provider_check;
ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_provider_check
 CHECK(provider IN ('calendly','calcom','json_api','form_webhook','google_calendar'));
ALTER TABLE integration_connections DROP CONSTRAINT integration_connections_status_check;
ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_status_check
 CHECK(status IN ('connected','awaiting_selection','error','disconnected'));
ALTER TABLE integration_connections ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE integration_connections ADD COLUMN sync_lease_id uuid;
ALTER TABLE integration_connections ADD COLUMN sync_lease_until timestamptz;
ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_business_id_id_key UNIQUE(business_id,id);
CREATE TABLE google_calendar_oauth_states (
 business_id uuid NOT NULL, state_hash text NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL, verifier_encrypted text, display_name text NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(business_id,state_hash),
 FOREIGN KEY(business_id) REFERENCES integration_tenant_directory(business_id)
);
CREATE TABLE google_calendar_snapshots (
 business_id uuid NOT NULL, connection_id uuid NOT NULL, external_id text NOT NULL CHECK(length(external_id)<=512),
 snapshot jsonb NOT NULL, ends_at timestamptz NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,connection_id,external_id),
 FOREIGN KEY(business_id,connection_id) REFERENCES integration_connections(business_id,id) ON DELETE CASCADE
);
CREATE INDEX google_calendar_snapshots_window ON google_calendar_snapshots(business_id,connection_id,ends_at);
ALTER TABLE google_calendar_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_calendar_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY google_calendar_oauth_states_tenant ON google_calendar_oauth_states
 USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE google_calendar_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_calendar_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY google_calendar_snapshots_tenant ON google_calendar_snapshots
 USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
