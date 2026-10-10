CREATE TABLE attribution_links (business_id uuid NOT NULL,id uuid NOT NULL,public_token text NOT NULL CHECK(public_token ~ '^[a-f0-9]{64}$'),created_by text NOT NULL,label text NOT NULL,destination_url text NOT NULL,tagged_url text NOT NULL,source text NOT NULL,campaign text NOT NULL,enabled boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id),UNIQUE(business_id,public_token));
CREATE TABLE attribution_link_students (business_id uuid NOT NULL,link_id uuid NOT NULL,student_id uuid NOT NULL,linked_by text NOT NULL,linked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,link_id,student_id),FOREIGN KEY(business_id,link_id) REFERENCES attribution_links(business_id,id) ON DELETE CASCADE);
CREATE TABLE attribution_link_daily (business_id uuid NOT NULL,link_id uuid NOT NULL,day date NOT NULL,requests bigint NOT NULL CHECK(requests>=0),PRIMARY KEY(business_id,link_id,day),FOREIGN KEY(business_id,link_id) REFERENCES attribution_links(business_id,id) ON DELETE CASCADE);
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['attribution_links','attribution_link_students','attribution_link_daily'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I USING (business_id=nullif(current_setting(''app.business_id'',true),'''')::uuid) WITH CHECK(business_id=nullif(current_setting(''app.business_id'',true),'''')::uuid)',table_name||'_tenant',table_name);
 END LOOP;
END $$;
