CREATE TABLE resources (
 id uuid PRIMARY KEY,
 business_id uuid NOT NULL,
 client_id uuid NOT NULL,
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK (kind IN ('link','file_metadata')),
 url text,
 file_name text,
 mime_type text,
 size_bytes bigint CHECK (size_bytes >= 0),
 storage_status text NOT NULL CHECK (storage_status IN ('linked','upload_pending')),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,id),
 CHECK ((kind='link' AND url IS NOT NULL AND storage_status='linked') OR (kind='file_metadata' AND file_name IS NOT NULL AND url IS NULL AND storage_status='upload_pending'))
);
CREATE TABLE assignments (
 id uuid PRIMARY KEY,
 business_id uuid NOT NULL,
 client_id uuid NOT NULL,
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '',
 due_at timestamptz,
 status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','submitted','completed','needs_revision')),
 submission_text text,
 submission_url text,
 submitted_at timestamptz,
 feedback text,
 reviewed_at timestamptz,
 reviewed_by text,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (business_id,id)
);
CREATE TABLE assignment_resources (
 business_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 resource_id uuid NOT NULL,
 PRIMARY KEY (business_id,assignment_id,resource_id),
 FOREIGN KEY (business_id,assignment_id) REFERENCES assignments(business_id,id),
 FOREIGN KEY (business_id,resource_id) REFERENCES resources(business_id,id)
);
CREATE INDEX resources_tenant_client ON resources(business_id,client_id,created_at);
CREATE INDEX assignments_tenant_client ON assignments(business_id,client_id,created_at);
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
CREATE POLICY resources_tenant ON resources USING (business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY assignments_tenant ON assignments USING (business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE assignment_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_resources_tenant ON assignment_resources USING (business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id=nullif(current_setting('app.business_id',true),'')::uuid);
