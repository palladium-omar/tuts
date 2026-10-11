-- A completed row-set decision replays only while its resulting work identities
-- remain current. Clients owns contact creation and its own durable decision.
CREATE TABLE billing_work_import_student_reviews (
 business_id uuid NOT NULL,
 import_id uuid NOT NULL,
 group_key text NOT NULL CHECK(group_key ~ '^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 reviewed_by text NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,import_id,group_key),
 FOREIGN KEY(business_id,import_id) REFERENCES billing_history_sources(business_id,id)
);
ALTER TABLE billing_work_import_student_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_work_import_student_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_work_import_student_reviews_tenant ON billing_work_import_student_reviews
 USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
