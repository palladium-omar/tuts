ALTER TABLE invoices ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE TABLE billing_student_aliases (
  business_id uuid NOT NULL, source_id uuid NOT NULL, target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,source_id), CHECK(source_id<>target_id)
);
ALTER TABLE billing_student_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_student_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_student_aliases_tenant ON billing_student_aliases
  USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid)
  WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
-- Invoker privileges retain tenant RLS. Historical invoice snapshots never move.
CREATE FUNCTION billing_student_root(student uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain(id,visited) AS (
    SELECT student, ARRAY[student]
    UNION ALL
    SELECT a.target_id, c.visited || a.target_id FROM chain c
    JOIN billing_student_aliases a ON a.source_id=c.id
    WHERE NOT a.target_id=ANY(c.visited) AND cardinality(c.visited)<100
  ) SELECT id FROM chain ORDER BY cardinality(visited) DESC LIMIT 1
$$;
