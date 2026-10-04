CREATE TABLE class_annotations (
 business_id uuid NOT NULL, class_id uuid NOT NULL, source text NOT NULL CHECK(source IN ('internal','external')),
 client_id uuid, status text CHECK(status IN ('scheduled','completed','cancelled')),
 PRIMARY KEY(business_id,source,class_id)
);
CREATE TABLE class_ledger (
 business_id uuid NOT NULL, class_id uuid NOT NULL, source text NOT NULL CHECK(source IN ('internal','external')),
 client_id uuid, title text NOT NULL, attendee_email text, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('scheduled','completed','cancelled')), provider_status text,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,source,class_id), CHECK(ends_at>starts_at)
);
CREATE INDEX class_ledger_month_idx ON class_ledger(business_id,starts_at);
ALTER TABLE class_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_annotations FORCE ROW LEVEL SECURITY;
CREATE POLICY class_annotations_tenant ON class_annotations USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE class_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY class_ledger_tenant ON class_ledger USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
