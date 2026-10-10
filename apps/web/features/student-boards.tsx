import { useEffect, useRef, useState, type FormEvent } from "react";
import { hasPermission } from "@palladium/contracts";
import { date, errorMessage, type Api, type Business, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import { StudentBoardCard } from "./student-board-card";
import { StudentBoardTemplates } from "./student-board-template";
import { StudentBoardTemplateReview } from "./student-board-template-review";
import { positionBetween } from "../lib/kanban-order";
import { StudentBoardKanban } from "./student-board-kanban";
import { BoardMoveQueue, type BoardDetail, type BoardMoveState } from "../lib/kanban-mutations";
import "./student-boards.css";

// Keep pending intent through view unmount/remount while its authenticated API lives.
const moveQueues = new WeakMap<Api, Map<string, BoardMoveQueue>>();

export function StudentBoards({ api, business, studentId, student, persistNavigation = false }: { api: Api; business: Business; studentId: string; student?: Row; persistNavigation?: boolean }) {
  const allowed = business.entitlements.includes("planning") && hasPermission(business, "planning.read"), canWrite = allowed && hasPermission(business, "planning.write"), canCreate = canWrite && hasPermission(business, "clients.read");
  const [boards, setBoards] = useState<Row[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0), [boardId, setBoardId] = useState<string | null>(null), [detail, setDetail] = useState<Row | null>(null), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState(""), [boardEditor, setBoardEditor] = useState<Row | null>(null), [columnEditor, setColumnEditor] = useState<Row | null>(null), [cardEditor, setCardEditor] = useState<Row | null>(null), [templates, setTemplates] = useState(false), [templateReview, setTemplateReview] = useState(false);
  const scope = `${business.id}/${studentId}/${boardId ?? "list"}`;
  const activeScope = useRef(scope); activeScope.current = scope;
  const [moveView, setMoveView] = useState<{ scope: string; queue: BoardMoveQueue; state: BoardMoveState } | null>(null);
  const [planningStudent, setPlanningStudent] = useState(student);
  useEffect(() => { setPlanningStudent(student); }, [student, studentId, business.id]);
  const currentMoves = moveView?.scope === scope ? moveView : null;
  const movesPending = !!currentMoves?.state.pending.length;
  const movesPaused = !!currentMoves?.state.error;
  const structureLocked = movesPending || movesPaused || !!currentMoves?.state.saving;
  const busy = !!boardEditor || !!columnEditor || !!cardEditor || templateReview;
  function urlBoard() {
    if (!persistNavigation || typeof window === "undefined") return null;
    const id = new URLSearchParams(window.location.search).get("board");
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  }
  function selectBoard(id: string | null) {
    setCardEditor(null); setColumnEditor(null); setBoardEditor(null);
    activeScope.current = `${business.id}/${studentId}/${id ?? "list"}`;
    setDetail(null); setMoveView(null); setBoardId(id);
    if (!persistNavigation) return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("board", id); else url.searchParams.delete("board");
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
  }
  useEffect(() => {
    if (!persistNavigation) return;
    const restore = () => { const restored = urlBoard(); activeScope.current = `${business.id}/${studentId}/${restored ?? "list"}`; setDetail(null); setMoveView(null); setBoardId(restored); setCardEditor(null); setColumnEditor(null); setBoardEditor(null); };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [persistNavigation, business.id, studentId]);
  useEffect(() => { setBoardId(urlBoard()); setDetail(null); setOffset(0); setBoardEditor(null); setColumnEditor(null); setCardEditor(null); setTemplates(false); setTemplateReview(false); }, [studentId, business.id, persistNavigation]);
  useEffect(() => {
    let cancelled = false, unsubscribe: (() => void) | undefined;
    setError(""); setLoading(true); setDetail(null); setMoveView(null);
    if (!allowed) { setLoading(false); return; }
    const attach = (queue: BoardMoveQueue) => {
      unsubscribe = queue.subscribe(state => {
        if (!cancelled && activeScope.current === scope) { setDetail(state.detail); setMoveView({ scope, queue, state }); }
      });
    };
    let byBoard = moveQueues.get(api);
    if (!byBoard) { byBoard = new Map(); moveQueues.set(api, byBoard); }
    const existing = boardId ? byBoard.get(scope) : undefined;
    if (existing && (existing.snapshot().pending.length || existing.snapshot().error)) {
      attach(existing); setLoading(false);
    } else {
      const load = boardId ? api(`planning/v1/boards/${boardId}`, "GET", undefined, undefined, { fresh: true }) : api(`planning/v1/boards?${new URLSearchParams({ studentId, limit: "20", offset: String(offset) })}`);
      load.then(data => {
        if (cancelled || activeScope.current !== scope) return;
        if (boardId) {
          const queue = existing ?? new BoardMoveQueue(api, data as BoardDetail);
          if (existing) queue.replaceSaved(data as BoardDetail);
          byBoard!.set(scope, queue); attach(queue);
        } else { setBoards(data.items ?? []); setTotal(data.total ?? 0); }
      }).catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    }
    // Background writes finish in their original board; detached listeners cannot
    // replace the board/student that the user has navigated to.
    return () => { cancelled = true; unsubscribe?.(); };
  }, [api, allowed, boardId, studentId, business.id, offset, revision]);
  async function refreshBoard(failureMessage = "The change was saved, but the board could not be refreshed.") {
    if (!boardId) { setRevision(n => n + 1); return; }
    const requestedScope = scope, queue = currentMoves?.queue;
    try {
      const data: BoardDetail = await api(`planning/v1/boards/${boardId}`, "GET", undefined, undefined, { fresh: true });
      if (activeScope.current !== requestedScope) return;
      if (queue) queue.replaceSaved(data); else setDetail(data);
    } catch (e) { if (activeScope.current === requestedScope) setError(`${failureMessage} ${errorMessage(e)}`); }
  }
  const board = detail?.item?.id === boardId && detail?.item?.studentId === studentId ? detail.item : null, canManage = canWrite && detail?.canManageStructure === true, columns: Row[] = [...(detail?.columns ?? [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)), cards: Row[] = detail?.cards ?? [];
  async function move(card: Row, columnId: string, position: number) {
    if (!canWrite || !board || busy || !currentMoves || movesPaused) return;
    setError(""); setMessage("");
    currentMoves.queue.enqueue({ cardId: card.id, columnId, position });
  }
  if (!allowed) return <Empty>Planning boards are not available with your current access.</Empty>;
  if (templates) return <StudentBoardTemplates api={api} studentId={studentId} student={planningStudent} canSaveProfile={hasPermission(business, "clients.write") && !["student", "parent"].includes(business.role)} onProfileSaved={setPlanningStudent} onClose={() => setTemplates(false)} onCreated={(id) => { setTemplates(false); selectBoard(id); setRevision((n) => n + 1); }} />;
  const learner = ["student", "parent"].includes(business.role);
  return <section className="planning-space" aria-label="Student planning boards"><Notice error={error} message={message} /><div className="student-boards-actions">{boardId && <button disabled={busy} onClick={() => { selectBoard(null); setMessage(""); }}>All boards</button>}<button disabled={loading || busy || structureLocked} onClick={() => setRevision((n) => n + 1)}>Refresh</button>{movesPending && !movesPaused && <span className="planning-save-status" role="status">Saving moves in background…</span>}{canCreate && !boardId && <><button onClick={() => setBoardEditor({ sharing: "student" })}>Blank board</button><button className="primary" onClick={() => setTemplates(true)}>Create application plan</button></>}{canManage && board && <><button disabled={busy || structureLocked} onClick={() => setBoardEditor(board)}>Board settings</button>{board.templateKey && <button disabled={busy || structureLocked} onClick={() => setTemplateReview(true)}>Review template version</button>}<button disabled={busy || structureLocked} onClick={() => setColumnEditor({ position: columns.length ? Math.max(...columns.map((row) => row.position)) + 1 : 0 })}>Add column</button></>}</div>
    {loading ? <Empty>Loading planning boards…</Empty> : !boardId ? <>{!boards.length && !error ? <Empty><h3>No planning boards yet.</h3><p>Choose an application path and we’ll organize your next steps. Or start a blank board for any goal.</p></Empty> : <div className="student-board-grid">{boards.map((row) => <article className="student-board-tile" key={row.id}><button onClick={() => selectBoard(row.id)}><h3>{row.name}</h3><p>{row.description}</p><div className="student-board-meta"><span className="tag">{row.sharing === "student" ? "Shared" : "Private"}</span>{row.templateVersion && <span className="tag">Template v{row.templateVersion}</span>}</div><small>Updated {date(row.updatedAt)}</small></button></article>)}</div>}{total > 20 && <div className="portal-pagination"><span>{total ? `${offset + 1}–${Math.min(offset + boards.length, total)} of ${total} boards` : ""}</span><button disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 20))}>Previous boards</button><button disabled={offset + 20 >= total} onClick={() => setOffset((value) => value + 20)}>Next boards</button></div>}</> : board && <><h2>{board.name}</h2><p className="crm-helper">{board.description}</p><div className="student-board-meta"><span className="tag">{board.sharing === "student" ? (learner ? "Shared with your tutor" : "Shared with student") : "Private"}</span>{board.templateVersion && <span className="tag">Template version {board.templateVersion}</span>}</div><p className="crm-helper">Drag any part of a task between columns. Open a task for notes, checklists and resources.</p>{!columns.length && <Empty>This board has no columns yet.{canManage ? " Add a column to begin." : " Your tutor can add columns."}</Empty>}<StudentBoardKanban key={scope} columns={columns} cards={cards} canWrite={canWrite && !movesPaused} canManage={canManage} busy={busy} structureBusy={structureLocked} onMove={move} onEdit={setCardEditor} onAdd={(column, position) => setCardEditor({ columnId: column.id, position })} onColumn={setColumnEditor} /></>}
    {currentMoves?.state.error && <div className="planning-move-recovery" role="alert"><p>{currentMoves.state.error}</p><p>{currentMoves.state.recovering ? "Loading the latest saved board…" : currentMoves.state.recovered ? "The latest saved board is shown. Review it before applying your pending moves." : "Your pending moves are retained. Load the latest board before retrying."}</p><ul>{currentMoves.state.pending.map((intent, index) => <li key={index}>{cards.find(card => card.id === intent.cardId)?.title ?? "Removed task"} → {columns.find(column => column.id === intent.columnId)?.name ?? "Removed column"}</li>)}</ul><div className="student-boards-actions"><button disabled={currentMoves.state.recovering || currentMoves.state.saving} onClick={() => void currentMoves.queue.refreshFailed()}>Load latest saved board</button><button disabled={!currentMoves.state.recovered || currentMoves.state.saving || currentMoves.state.recovering} onClick={() => currentMoves.queue.retryReviewed()}>Apply my pending moves</button><button disabled={!currentMoves.state.recovered || currentMoves.state.saving || currentMoves.state.recovering} onClick={() => currentMoves.queue.discardReviewed()}>Discard pending moves</button></div></div>}
    {boardEditor && <BoardEditor api={api} studentId={studentId} board={boardEditor} onClose={() => setBoardEditor(null)} onSaved={(id) => { setBoardEditor(null); selectBoard(id); setRevision((n) => n + 1); }} />}
    {columnEditor && board && <ColumnEditor api={api} board={board} column={columnEditor} columns={columns} cards={cards} onClose={() => setColumnEditor(null)} onSaved={refreshBoard} />}
    {cardEditor && board && <StudentBoardCard key={`${cardEditor.id ?? "new"}:${structureLocked ? "pending" : "ready"}`} api={api} business={business} studentId={studentId} board={board} columns={columns} card={cards.find(card => card.id === cardEditor.id) ?? cardEditor} canWrite={canWrite && !structureLocked} onClose={() => setCardEditor(null)} onSaved={refreshBoard} />}
    {templateReview && board && <StudentBoardTemplateReview api={api} board={board} cards={cards} columns={columns} onClose={() => setTemplateReview(false)} onSaved={refreshBoard} />}
  </section>;
}

function BoardEditor({ api, studentId, board, onClose, onSaved }: { api: Api; studentId: string; board: Row; onClose: () => void; onSaved: (id: string | null) => void }) {
  const [name, setName] = useState(board.name ?? ""), [description, setDescription] = useState(board.description ?? ""), [sharing, setSharing] = useState(board.sharing ?? "private"), [busy, setBusy] = useState(false), [error, setError] = useState(""), [deleting, setDeleting] = useState(false), [confirmed, setConfirmed] = useState(false), [requestKey] = useState(() => crypto.randomUUID());
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const data = await api(`planning/v1/boards${board.id ? `/${board.id}` : ""}`, board.id ? "PATCH" : "POST", { name: name.trim(), description, sharing, ...(board.id ? { expectedRevision: board.revision } : { studentId }) }, board.id ? undefined : requestKey); onSaved(data.item.id); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  async function remove() { if (!confirmed) return; setBusy(true); setError(""); try { await api(`planning/v1/boards/${board.id}`, "DELETE", { expectedRevision: board.revision }); onSaved(null); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <Modal title={board.id ? "Board settings" : "Create planning board"} onClose={() => { if (!busy) onClose(); }}><Notice error={error} /><form onSubmit={(e) => void save(e)}><fieldset className="crm-record-fieldset" disabled={busy}><label>Board name<input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label><label>Description<textarea maxLength={10000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label><label>Visibility<select value={sharing} onChange={(e) => setSharing(e.target.value)}><option value="private">Creator and business administrators</option><option value="student">Shared with student and authorized guardians</option></select></label><p className="crm-helper">Private boards are visible only to their creator and authorized business administrators. Shared boards appear in the student portal. Contacts and other student records keep their existing access rules.</p></fieldset><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save board"}</button></div></form>{board.id && <div className="student-board-danger">{deleting ? <><label className="student-board-checklist-row"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />Permanently delete this board, its columns, tasks and checklists.</label><button disabled={busy || !confirmed} onClick={() => void remove()}>Confirm delete board</button><button disabled={busy} onClick={() => setDeleting(false)}>Cancel deletion</button></> : <button onClick={() => setDeleting(true)}>Delete board</button>}</div>}</Modal>;
}

function ColumnEditor({ api, board, column, columns, cards, onClose, onSaved }: { api: Api; board: Row; column: Row; columns: Row[]; cards: Row[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(column.name ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [deleting, setDeleting] = useState(false), [confirmed, setConfirmed] = useState(false), [target, setTarget] = useState(""), [requestKey] = useState(() => crypto.randomUUID());
  const ordered = [...columns].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const originalBefore = ordered[ordered.findIndex(row => row.id === column.id) + 1]?.id ?? "last";
  const [beforeId, setBeforeId] = useState(originalBefore);
  const count = cards.filter((card) => card.columnId === column.id).length;
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); const other = ordered.filter(row => row.id !== column.id), at = beforeId === "last" ? other.length : other.findIndex(row => row.id === beforeId); const position = positionBetween(other[at - 1]?.position, other[at]?.position); try { await api(`planning/v1/boards/${board.id}/columns${column.id ? `/${column.id}` : ""}`, column.id ? "PATCH" : "POST", { name: name.trim(), expectedBoardRevision: board.revision, ...(column.id ? { expectedRevision: column.revision, ...(beforeId !== originalBefore ? { position } : {}) } : { position: column.position }) }, column.id ? undefined : requestKey); await onSaved(); onClose(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  async function remove() { if (!confirmed || count && !target) return; setBusy(true); setError(""); try { await api(`planning/v1/boards/${board.id}/columns/${column.id}`, "DELETE", { expectedRevision: column.revision, expectedBoardRevision: board.revision, ...(target ? { moveCardsToColumnId: target } : {}) }); await onSaved(); onClose(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <Modal title={column.id ? "Column settings" : "Add column"} onClose={() => { if (!busy) onClose(); }}><Notice error={error} /><form onSubmit={(e) => void save(e)}><label>Column name<input disabled={busy} required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>{column.id && columns.length > 1 && <label>Column order<select disabled={busy} value={beforeId} onChange={event => setBeforeId(event.target.value)}>{ordered.filter(row => row.id !== column.id).map(row => <option key={row.id} value={row.id}>Before {row.name}</option>)}<option value="last">Last column</option></select></label>}<div className="form-actions"><button disabled={busy} type="button" onClick={onClose}>Cancel</button><button disabled={busy} className="primary">Save column</button></div></form>{column.id && <div className="student-board-danger">{deleting ? <>{count > 0 && <label>Move {count} task(s) before deleting<select disabled={busy} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose another column</option>{columns.filter((row) => row.id !== column.id).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}<label className="student-board-checklist-row"><input disabled={busy} type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />Delete this column{count ? " and move its tasks to the chosen column" : ""}.</label><button disabled={busy || !confirmed || !!count && !target} onClick={() => void remove()}>Confirm delete column</button><button disabled={busy} onClick={() => setDeleting(false)}>Cancel deletion</button></> : <button onClick={() => setDeleting(true)}>Delete column</button>}</div>}</Modal>;
}
