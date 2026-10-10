ALTER TABLE integration_connections ADD COLUMN cal_webhook_secret_encrypted text;
CREATE TABLE portal_booking_configs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, owner_user_id text NOT NULL,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
 booking_url text NOT NULL CHECK(length(booking_url) <= 2048),
 connection_id uuid, enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,owner_user_id)
);
CREATE TABLE cal_webhook_receipts (
 business_id uuid NOT NULL, connection_id uuid NOT NULL, payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 trigger_event text NOT NULL, provider_created_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,connection_id,payload_hash)
);
ALTER TABLE portal_booking_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_booking_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_booking_configs_tenant ON portal_booking_configs
 USING (business_id=nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK (business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE cal_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cal_webhook_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY cal_webhook_receipts_tenant ON cal_webhook_receipts
 USING (business_id=nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK (business_id=nullif(current_setting('app.business_id',true),'')::uuid);
