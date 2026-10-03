CREATE TABLE notifications (
 id uuid PRIMARY KEY,
 business_id uuid NOT NULL,
 source_event_id uuid,
 source_event_type text,
 recipient_client_id uuid,
 channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email')),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
 message text NOT NULL CHECK (length(message) BETWEEN 1 AND 5000),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','read','cancelled')),
 delivery_mode text NOT NULL DEFAULT 'queue_only' CHECK (delivery_mode='queue_only'),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,source_event_id)
);
CREATE INDEX notifications_tenant_created ON notifications(business_id,created_at,id);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant ON notifications USING (business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id=nullif(current_setting('app.business_id',true),'')::uuid);
