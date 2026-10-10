ALTER TABLE assignments ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE resources ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE resources ADD COLUMN purpose text NOT NULL DEFAULT 'material' CHECK(purpose IN ('material','submission'));
ALTER TABLE resources ADD COLUMN submission_assignment_id uuid;
ALTER TABLE resources ADD CONSTRAINT resources_submission_assignment FOREIGN KEY(business_id,submission_assignment_id) REFERENCES assignments(business_id,id);
ALTER TABLE resources ADD CONSTRAINT resources_submission_purpose CHECK((purpose='material' AND submission_assignment_id IS NULL) OR (purpose='submission' AND submission_assignment_id IS NOT NULL));
ALTER TABLE resources DROP CONSTRAINT resources_kind_check;
ALTER TABLE resources ADD CONSTRAINT resources_kind_check CHECK(kind IN ('link','google_doc','file_metadata'));
ALTER TABLE resources DROP CONSTRAINT resources_storage_invariant;
ALTER TABLE resources ADD CONSTRAINT resources_storage_invariant CHECK (
 (kind IN ('link','google_doc') AND url IS NOT NULL AND storage_status='linked' AND storage_key IS NULL) OR
 (kind='file_metadata' AND file_name IS NOT NULL AND url IS NULL AND (
  (storage_status='upload_pending' AND storage_key IS NULL) OR
  (storage_status='stored' AND storage_key IS NOT NULL AND mime_type IS NOT NULL AND size_bytes>0)
 ))
);
CREATE TABLE assignment_submission_resources (
 business_id uuid NOT NULL,assignment_id uuid NOT NULL,resource_id uuid NOT NULL,
 PRIMARY KEY(business_id,assignment_id,resource_id),
 FOREIGN KEY(business_id,assignment_id) REFERENCES assignments(business_id,id),
 FOREIGN KEY(business_id,resource_id) REFERENCES resources(business_id,id)
);
CREATE TABLE learning_student_aliases (
 business_id uuid NOT NULL,source_id uuid NOT NULL,target_id uuid NOT NULL,revision integer NOT NULL,
 PRIMARY KEY(business_id,source_id),CHECK(source_id<>target_id)
);
ALTER TABLE assignment_submission_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_submission_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_submission_resources_tenant ON assignment_submission_resources USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE learning_student_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_student_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY learning_student_aliases_tenant ON learning_student_aliases USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
