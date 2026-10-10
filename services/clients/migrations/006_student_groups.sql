ALTER TABLE clients ADD COLUMN photo text CHECK(photo IS NULL OR length(photo)<=349600);
CREATE TABLE student_groups (
 business_id uuid NOT NULL,id uuid NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
 description text CHECK(description IS NULL OR length(description)<=2000),revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id)
);
CREATE INDEX student_groups_list_idx ON student_groups(business_id,created_at DESC,id);
CREATE TABLE student_group_members (
 business_id uuid NOT NULL,group_id uuid NOT NULL,student_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,group_id,student_id),
 FOREIGN KEY(business_id,group_id) REFERENCES student_groups(business_id,id) ON DELETE CASCADE,
 FOREIGN KEY(business_id,student_id) REFERENCES clients(business_id,id) ON DELETE CASCADE
);
CREATE INDEX student_group_members_student_idx ON student_group_members(business_id,student_id,group_id);
ALTER TABLE student_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY student_groups_tenant ON student_groups USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE student_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_group_members FORCE ROW LEVEL SECURITY;
CREATE POLICY student_group_members_tenant ON student_group_members USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
