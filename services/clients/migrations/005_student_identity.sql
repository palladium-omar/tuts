-- Additive identity migration: legacy IDs and contact columns remain intact.
-- DDL migration transaction uses the owning role; restore FORCE before commit.
ALTER TABLE clients NO FORCE ROW LEVEL SECURITY;
ALTER TABLE client_payers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE client_external_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clients ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE clients ADD COLUMN normalized_name text NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN merged_into uuid;
ALTER TABLE clients ADD COLUMN merged_at timestamptz;
ALTER TABLE clients ADD COLUMN portal_protected_at timestamptz;
ALTER TABLE clients ADD CONSTRAINT clients_merge_target FOREIGN KEY (business_id,merged_into) REFERENCES clients(business_id,id);
ALTER TABLE clients ADD CONSTRAINT clients_merge_not_self CHECK(merged_into IS NULL OR merged_into <> id);
UPDATE clients SET normalized_name=lower(regexp_replace(normalize(btrim(display_name),NFKC),'\s+',' ','g'));
CREATE INDEX clients_name_candidates_idx ON clients(business_id,normalized_name) WHERE kind='student' AND merged_into IS NULL;
CREATE TABLE related_contacts (
 business_id uuid NOT NULL,id uuid NOT NULL,display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id)
);
CREATE TABLE contact_addresses (
 business_id uuid NOT NULL,id uuid NOT NULL,contact_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('email','phone')),
 value text NOT NULL CHECK(length(value) BETWEEN 1 AND 320),normalized_value text NOT NULL,
 label text NOT NULL DEFAULT 'personal' CHECK(length(label) BETWEEN 1 AND 60),is_primary boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id),UNIQUE(business_id,contact_id,kind,normalized_value),
 FOREIGN KEY(business_id,contact_id) REFERENCES related_contacts(business_id,id) ON DELETE CASCADE
);
CREATE TABLE student_contacts (
 business_id uuid NOT NULL,student_id uuid NOT NULL,contact_id uuid NOT NULL,
 relationship text NOT NULL CHECK(relationship IN ('student','parent','guardian','sponsor','self','other')),is_primary boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,student_id,contact_id),
 FOREIGN KEY(business_id,student_id) REFERENCES clients(business_id,id) ON DELETE CASCADE,
 FOREIGN KEY(business_id,contact_id) REFERENCES related_contacts(business_id,id) ON DELETE CASCADE
);
CREATE TABLE duplicate_dismissals (
 business_id uuid NOT NULL,source_id uuid NOT NULL,target_id uuid NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,source_id,target_id),CHECK(source_id<target_id),
 FOREIGN KEY(business_id,source_id) REFERENCES clients(business_id,id),FOREIGN KEY(business_id,target_id) REFERENCES clients(business_id,id)
);
CREATE TABLE student_merge_audit (
 business_id uuid NOT NULL,id uuid NOT NULL,source_id uuid NOT NULL,target_id uuid NOT NULL,actor_id text NOT NULL,
 source_snapshot jsonb NOT NULL,target_snapshot jsonb NOT NULL,field_choices jsonb NOT NULL,revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id)
);
ALTER TABLE client_external_sources ADD COLUMN original_client_id uuid;
UPDATE client_external_sources SET original_client_id=client_id;
ALTER TABLE client_external_sources ALTER COLUMN original_client_id SET NOT NULL;
INSERT INTO related_contacts(business_id,id,display_name) SELECT business_id,id,display_name FROM clients;
INSERT INTO student_contacts(business_id,student_id,contact_id,relationship,is_primary)
 SELECT business_id,id,id,'student',true FROM clients WHERE kind='student';
INSERT INTO student_contacts(business_id,student_id,contact_id,relationship,is_primary)
 SELECT business_id,student_id,payer_id,relationship,false FROM client_payers ON CONFLICT DO NOTHING;
INSERT INTO contact_addresses(business_id,id,contact_id,kind,value,normalized_value,is_primary)
 SELECT business_id,gen_random_uuid(),id,'email',email,lower(btrim(email)),true FROM clients WHERE email IS NOT NULL AND btrim(email)<>'';
INSERT INTO contact_addresses(business_id,id,contact_id,kind,value,normalized_value,is_primary)
 SELECT business_id,gen_random_uuid(),id,'phone',phone,regexp_replace(phone,'[^0-9+]','','g'),true FROM clients WHERE phone IS NOT NULL AND btrim(phone)<>'';
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['related_contacts','contact_addresses','student_contacts','duplicate_dismissals','student_merge_audit'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I USING (business_id = nullif(current_setting(''app.business_id'',true),'''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.business_id'',true),'''')::uuid)',table_name||'_tenant',table_name);
 END LOOP;
END $$;

ALTER TABLE clients FORCE ROW LEVEL SECURITY;
ALTER TABLE client_payers FORCE ROW LEVEL SECURITY;
ALTER TABLE client_external_sources FORCE ROW LEVEL SECURITY;
