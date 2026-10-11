-- Reviewed source row sets are identities within one import, never unique names.
CREATE TABLE client_work_import_identities (
  business_id uuid NOT NULL,
  import_id uuid NOT NULL,
  group_key text NOT NULL CHECK(group_key ~ '^[a-f0-9]{64}$'),
  source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 200),
  action text NOT NULL CHECK(action IN ('create','link')),
  student_id uuid NOT NULL,
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,import_id,group_key),
  FOREIGN KEY(business_id,student_id) REFERENCES clients(business_id,id)
);
CREATE INDEX client_work_import_identities_student ON client_work_import_identities(business_id,student_id);
ALTER TABLE client_work_import_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_work_import_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY client_work_import_identities_tenant ON client_work_import_identities
  USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid)
  WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
