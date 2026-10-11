/** Board status follows explicit known labels. Custom names remain pending. */
export function planningColumnKind(name:string):'pending'|'in_progress'|'completed' {
 const normalized=name.trim().toLowerCase();
 if(['done','completed','complete'].includes(normalized))return 'completed';
 if(['in progress','in-progress','review'].includes(normalized))return 'in_progress';
 return 'pending';
}
// One aggregate statement computes unrestricted totals, then bounds the two lists.
// Tenant RLS also applies to canonical aliases, boards, columns and cards.
export const overviewSql=`WITH visible_boards AS MATERIALIZED (
 SELECT id,name FROM planning_boards
 WHERE archived_at IS NULL AND sharing='student' AND planning_canonical_student(student_id)=$1::uuid
), tasks AS MATERIALIZED (
 SELECT c.id,c.title,c.board_id,b.name board_name,c.deadline,
 CASE WHEN lower(trim(col.name)) IN ('done','completed','complete') THEN 'completed'
      WHEN lower(trim(col.name)) IN ('in progress','in-progress','review') THEN 'in_progress'
      ELSE 'pending' END column_kind,
 (c.deadline->>'dueAt')::timestamptz due_at
 FROM planning_cards c JOIN visible_boards b ON b.id=c.board_id
 JOIN planning_columns col ON col.id=c.column_id AND col.board_id=c.board_id
 WHERE c.archived_at IS NULL
), board_counts AS (
 SELECT b.id,b.name,count(t.id)::integer total,
 count(t.id) FILTER (WHERE t.column_kind='pending')::integer pending,
 count(t.id) FILTER (WHERE t.column_kind='in_progress')::integer "inProgress",
 count(t.id) FILTER (WHERE t.column_kind='completed')::integer completed,
 count(t.id) FILTER (WHERE t.column_kind<>'completed' AND t.due_at<now())::integer overdue,
 count(t.id) FILTER (WHERE t.column_kind<>'completed' AND t.due_at>=now() AND t.due_at<=now()+interval '168 hours')::integer "dueSoon"
 FROM visible_boards b LEFT JOIN tasks t ON t.board_id=b.id GROUP BY b.id,b.name
), next_tasks AS (
 SELECT id,title,board_id AS "boardId",board_name AS "boardName",column_kind AS "columnKind",deadline
 FROM tasks WHERE column_kind<>'completed' ORDER BY due_at ASC NULLS LAST,id LIMIT 10
), upcoming_tasks AS (
 SELECT id,title,board_id AS "boardId",board_name AS "boardName",column_kind AS "columnKind",deadline
 FROM tasks WHERE column_kind<>'completed' AND due_at>=now() ORDER BY due_at ASC,id LIMIT 5
), next_boards AS (
 SELECT * FROM board_counts ORDER BY overdue DESC,"dueSoon" DESC,name,id LIMIT 20
)
SELECT jsonb_build_object(
 'total',count(*),'pending',count(*) FILTER (WHERE column_kind='pending'),
 'inProgress',count(*) FILTER (WHERE column_kind='in_progress'),'completed',count(*) FILTER (WHERE column_kind='completed'),
 'overdue',count(*) FILTER (WHERE column_kind<>'completed' AND due_at<now()),
 'dueSoon',count(*) FILTER (WHERE column_kind<>'completed' AND due_at>=now() AND due_at<=now()+interval '168 hours')) summary,
 coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY (n.deadline->>'dueAt')::timestamptz ASC NULLS LAST,n.id) FROM next_tasks n),'[]'::jsonb) tasks,
 coalesce((SELECT jsonb_agg(to_jsonb(u) ORDER BY (u.deadline->>'dueAt')::timestamptz ASC,u.id) FROM upcoming_tasks u),'[]'::jsonb) "upcomingTasks",
 coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.overdue DESC,b."dueSoon" DESC,b.name,b.id) FROM next_boards b),'[]'::jsonb) boards FROM tasks`;
