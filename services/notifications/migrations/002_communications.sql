CREATE TABLE communication_connections (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN ('smtp','resend','whatsapp_business','ai_agent')),
 display_name text NOT NULL,config jsonb NOT NULL,credentials_encrypted text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 revision integer NOT NULL DEFAULT 1,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(business_id,id)
);
CREATE TABLE communication_campaigns (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,connection_id uuid NOT NULL,connection_revision integer NOT NULL,channel text NOT NULL CHECK(channel IN ('email','whatsapp')),
 subject text NOT NULL DEFAULT '',message text NOT NULL DEFAULT '',template jsonb,selection jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','completed','cancelled')),
 created_by text NOT NULL,approved_by text,approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,id),FOREIGN KEY(business_id,connection_id) REFERENCES communication_connections(business_id,id)
);
CREATE TABLE communication_recipients (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,campaign_id uuid NOT NULL,client_id uuid NOT NULL,display_name text NOT NULL,address text,
 subject text NOT NULL DEFAULT '',message text NOT NULL DEFAULT '',template jsonb,
 status text NOT NULL CHECK(status IN ('pending','sending','accepted','failed','unknown','skipped')),reason text,provider_message_id text,
 lease_token uuid,lease_until timestamptz,attempted_at timestamptz,accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,campaign_id,client_id),FOREIGN KEY(business_id,campaign_id) REFERENCES communication_campaigns(business_id,id)
);
CREATE TABLE communication_consent (
 business_id uuid NOT NULL,client_id uuid NOT NULL,email_opt_in boolean,whatsapp_opt_in boolean,event_occurred_at timestamptz NOT NULL,
 PRIMARY KEY(business_id,client_id)
);
CREATE INDEX communication_campaigns_tenant ON communication_campaigns(business_id,created_at DESC);
CREATE INDEX communication_recipients_queue ON communication_recipients(business_id,campaign_id,status,created_at);
CREATE INDEX communication_dispatch_discovery ON service_outbox ((event->>'businessId')) WHERE event->>'type'='notifications.campaign-queued.v1';
ALTER TABLE communication_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_connections_tenant ON communication_connections USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE communication_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_campaigns_tenant ON communication_campaigns USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE communication_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_recipients_tenant ON communication_recipients USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE communication_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_consent_tenant ON communication_consent USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
