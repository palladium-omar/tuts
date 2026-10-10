ALTER TABLE sessions DROP CONSTRAINT sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check CHECK(status IN ('scheduled','completed','cancelled','no_show'));
ALTER TABLE external_sessions DROP CONSTRAINT external_sessions_status_check;
ALTER TABLE external_sessions ADD CONSTRAINT external_sessions_status_check CHECK(status IN ('scheduled','completed','cancelled','no_show'));
ALTER TABLE class_annotations DROP CONSTRAINT class_annotations_status_check;
ALTER TABLE class_annotations ADD CONSTRAINT class_annotations_status_check CHECK(status IN ('scheduled','completed','cancelled','no_show'));
ALTER TABLE class_ledger DROP CONSTRAINT class_ledger_status_check;
ALTER TABLE class_ledger ADD CONSTRAINT class_ledger_status_check CHECK(status IN ('scheduled','completed','cancelled','no_show'));
ALTER TABLE external_sessions ADD COLUMN provider_updated_at timestamptz,
  ADD COLUMN revision_source text NOT NULL DEFAULT 'legacy' CHECK(revision_source IN ('legacy','provider','observed'));
ALTER TABLE class_ledger ADD COLUMN assigned_tutor_id text,
  ADD COLUMN connection_id uuid,
  ADD COLUMN attendance_source text NOT NULL DEFAULT 'session' CHECK(attendance_source IN ('session','tutor','provider'));
ALTER TABLE class_annotations ADD COLUMN updated_by text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE scheduling_student_aliases (
 business_id uuid NOT NULL, source_id uuid NOT NULL,target_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,source_id),CHECK(source_id<>target_id)
);
ALTER TABLE scheduling_student_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_student_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduling_student_aliases_tenant ON scheduling_student_aliases
 USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
-- SECURITY INVOKER: each lookup retains the caller's forced tenant RLS.
CREATE FUNCTION scheduling_canonical_student(student_id uuid) RETURNS uuid
 LANGUAGE sql STABLE AS $$
 WITH RECURSIVE chain(id,visited,depth) AS (
   SELECT student_id,ARRAY[student_id],0 WHERE student_id IS NOT NULL
   UNION ALL
   SELECT a.target_id,c.visited||a.target_id,c.depth+1
   FROM chain c JOIN scheduling_student_aliases a ON a.source_id=c.id
   WHERE c.depth<32 AND NOT a.target_id=ANY(c.visited)
 ) SELECT id FROM chain ORDER BY depth DESC LIMIT 1
$$;
