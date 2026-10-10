-- Reviewed row-level associations never change preserved source names or raw files.
CREATE TABLE billing_work_identities (
 business_id uuid NOT NULL,
 work_id uuid NOT NULL,
 student_id uuid,
 status text NOT NULL CHECK(status IN ('linked','unknown','ambiguous')),
 work_revision integer NOT NULL CHECK(work_revision>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500),
 reviewed_by text NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,work_id),
 FOREIGN KEY(business_id,work_id) REFERENCES billing_work_log(business_id,id),
 CHECK((status='linked' AND student_id IS NOT NULL) OR (status<>'linked' AND student_id IS NULL))
);
CREATE INDEX billing_work_identities_student ON billing_work_identities(business_id,student_id) WHERE status='linked';
ALTER TABLE billing_work_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_work_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_work_identities_tenant ON billing_work_identities
 USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
