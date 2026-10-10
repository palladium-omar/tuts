CREATE TABLE planning_student_aliases (
 business_id uuid NOT NULL,source_id uuid NOT NULL,target_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 PRIMARY KEY(business_id,source_id),CHECK(source_id<>target_id)
);
CREATE FUNCTION planning_canonical_student(student_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 WITH RECURSIVE chain(id,visited,depth) AS (
 SELECT student_id,ARRAY[student_id],0 WHERE student_id IS NOT NULL
 UNION ALL SELECT a.target_id,c.visited||a.target_id,c.depth+1
 FROM chain c JOIN planning_student_aliases a ON a.source_id=c.id
 WHERE c.depth<32 AND NOT a.target_id=ANY(c.visited)
 ) SELECT id FROM chain ORDER BY depth DESC LIMIT 1
$$;
CREATE TABLE planning_templates (
 business_id uuid NOT NULL,template_key text NOT NULL,version integer NOT NULL CHECK(version>0),
 name text NOT NULL,definition jsonb NOT NULL,system boolean NOT NULL DEFAULT false,created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,template_key,version)
);
CREATE TABLE planning_boards (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,student_id uuid NOT NULL,name text NOT NULL,description text NOT NULL DEFAULT '',
 sharing text NOT NULL DEFAULT 'private' CHECK(sharing IN ('private','student')),created_by text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),template_key text,template_version integer,applicability jsonb,
 archived_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,id),
 FOREIGN KEY(business_id,template_key,template_version) REFERENCES planning_templates(business_id,template_key,version)
);
CREATE INDEX planning_boards_student ON planning_boards(business_id,student_id,updated_at DESC) WHERE archived_at IS NULL;
CREATE TABLE planning_columns (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,board_id uuid NOT NULL,name text NOT NULL,position double precision NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,board_id,id),CHECK(position BETWEEN -1000000000 AND 1000000000),
 FOREIGN KEY(business_id,board_id) REFERENCES planning_boards(business_id,id) ON DELETE CASCADE
);
CREATE TABLE planning_cards (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,board_id uuid NOT NULL,column_id uuid NOT NULL,title text NOT NULL,
 description text NOT NULL DEFAULT '',position double precision NOT NULL,checklist jsonb NOT NULL DEFAULT '[]',
 resource_references jsonb NOT NULL DEFAULT '[]',deadline jsonb,learning_assignment_id uuid,template_card_key text,
 deadline_edited boolean NOT NULL DEFAULT false,created_by text NOT NULL,revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 archived_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(position BETWEEN -1000000000 AND 1000000000),
 FOREIGN KEY(business_id,board_id,column_id) REFERENCES planning_columns(business_id,board_id,id),
 FOREIGN KEY(business_id,board_id) REFERENCES planning_boards(business_id,id) ON DELETE CASCADE
);
CREATE INDEX planning_cards_board ON planning_cards(business_id,board_id,column_id,position,id) WHERE archived_at IS NULL;
CREATE TABLE planning_instantiations (
 business_id uuid NOT NULL,actor_id text NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL,
 board_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,actor_id,idempotency_key),
 FOREIGN KEY(business_id,board_id) REFERENCES planning_boards(business_id,id)
);
ALTER TABLE planning_student_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning_student_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY planning_student_aliases_tenant ON planning_student_aliases USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE planning_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY planning_templates_tenant ON planning_templates USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE planning_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning_boards FORCE ROW LEVEL SECURITY;
CREATE POLICY planning_boards_tenant ON planning_boards USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE planning_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning_columns FORCE ROW LEVEL SECURITY;
CREATE POLICY planning_columns_tenant ON planning_columns USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE planning_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY planning_cards_tenant ON planning_cards USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE planning_instantiations ENABLE ROW LEVEL SECURITY;
ALTER TABLE planning_instantiations FORCE ROW LEVEL SECURITY;
CREATE POLICY planning_instantiations_tenant ON planning_instantiations USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
