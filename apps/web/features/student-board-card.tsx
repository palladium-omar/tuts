import { useEffect, useState, type FormEvent } from "react";
import { date, downloadFile, errorMessage, type Api, type Business, type Row } from "../lib/api";
import { hasPermission } from "@palladium/contracts";
import { DatePicker } from "../components/date-picker";
import { zonedDateInput, zonedDateInstant } from "../lib/zoned-date";
import { Modal, Notice } from "../components/shared";

export function publicLink(value: string) { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } }
export function deadlineTime(deadline: Row) { try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: deadline.timeZone }).format(new Date(deadline.dueAt)); } catch { return date(deadline.dueAt); } }
export function DeadlineLabel({ deadline }: { deadline?: Row | null }) {
  if (!deadline) return null;
  let when = "Date needs confirmation";
  if (deadline.dueAt) when = deadlineTime(deadline);
  return <div className="student-board-banner"><strong>{when}</strong><br />{deadline.timeZone} · {({ verified: "Verified in template source review", requires_confirmation: "Requires confirmation", user_set: "Personal date" } as Record<string, string>)[deadline.status] ?? "Requires confirmation"}{deadline.verifiedAt && <><br />Source reviewed {date(deadline.verifiedAt)}</>}{deadline.round && <><br />Round: {deadline.round}</>}{deadline.applicability && <p>{deadline.applicability}</p>}{deadline.sourceUrls?.map((url: string) => publicLink(url) && <a className="student-template-source" key={url} href={url} target="_blank" rel="noopener noreferrer">Official source ↗</a>)}</div>;
}

type CardProps = { api: Api; business: Business; studentId: string; board: Row; columns: Row[]; card: Row; canWrite: boolean; onClose: () => void; onSaved: () => Promise<void> };

// Everyday task actions have their own view; editing metadata is an explicit choice.
export function StudentBoardCard(props: CardProps) {
  const { api, business, columns, canWrite, onClose, onSaved } = props;
  const [current, setCurrent] = useState(props.card), [editing, setEditing] = useState(!props.card.id);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState("");
  const learning = business.entitlements.includes("learning") && hasPermission(business, "learning.read");
  async function tick(id: string, done: boolean) {
    if (busy || !canWrite) return;
    const previous = current;
    setBusy(true); setError(""); setSaved("");
    const checklist = (current.checklist ?? []).map((row: Row) => row.id === id ? { ...row, done } : row);
    setCurrent({ ...current, checklist });
    try {
      const result = await api(`planning/v1/cards/${current.id}`, "PATCH", { checklist, expectedRevision: current.revision });
      setCurrent(result.item); setSaved("Checklist saved"); await onSaved();
    } catch (e) {
      setCurrent(previous);
      setError(`We couldn't confirm your change. ${errorMessage(e)}`);
      try { const result = await api(`planning/v1/cards/${current.id}`); setCurrent(result.item); await onSaved(); } catch {}
    } finally { setBusy(false); requestAnimationFrame(() => { if (document.activeElement === document.body) document.getElementById(`planning-check-${id}`)?.focus(); }); }
  }
  if (editing) return <StudentBoardCardEditor {...props} card={current} onClose={() => { if (current.id) setEditing(false); else onClose(); }} onSaved={async () => {
    if (!current.id) { await onSaved(); onClose(); return; }
    try { const result = await api(`planning/v1/cards/${current.id}`); setCurrent(result.item); } catch { onClose(); }
    await onSaved();
  }} />;
  const checklist: Row[] = current.checklist ?? [], references: Row[] = current.references ?? [];
  const completed = checklist.filter(row => row.done).length;
  return <Modal title={current.title} onClose={() => { if (!busy) onClose(); }}>
    <div className="planning-task-view">
      <Notice error={error} />
      <div className="planning-task-toolbar"><span className="tag">{columns.find(row => row.id === current.columnId)?.name}</span>{canWrite && <button disabled={busy} onClick={() => setEditing(true)}>Edit task</button>}</div>
      {current.description && <p className="planning-task-description">{current.description}</p>}
      {current.deadline && <DeadlineLabel deadline={current.deadline} />}
      {checklist.length > 0 && <section className="planning-task-checklist-section"><div className="planning-task-section-title"><h3>Your checklist</h3><span>{completed} of {checklist.length}</span></div><progress value={completed} max={checklist.length} aria-label="Checklist progress" />{checklist.map(row => <label className={`planning-task-check${row.done ? " is-complete" : ""}`} key={row.id}><input id={`planning-check-${row.id}`} type="checkbox" checked={row.done} disabled={busy || !canWrite} onChange={event => void tick(row.id, event.target.checked)} /><span>{row.text}</span></label>)}<small role="status">{busy ? "Saving checklist…" : saved || (canWrite ? "Changes save automatically." : "View only")}</small></section>}
      {references.length > 0 && <section><h3>Documents & resources</h3><div className="planning-task-references">{references.map((row, index) => row.kind === "learning_resource" ? <ResourcePreview key={index} api={api} business={business} allowed={learning} reference={row} /> : publicLink(row.url) && <a className="planning-task-reference" key={index} href={row.url} target="_blank" rel="noopener noreferrer"><span><small>{row.kind === "google_doc" ? "Google Docs essay" : "Reference"}</small><strong>{row.label}</strong></span><span aria-hidden="true">↗</span></a>)}</div>{references.some(row => row.kind === "google_doc") && <p className="crm-helper">Your tutor controls sharing in Google Docs. Ask them for access if the document won't open.</p>}</section>}
      {current.learningAssignmentId && learning && <RelatedHomework api={api} id={current.learningAssignmentId} />}
      <div className="form-actions"><button disabled={busy} onClick={onClose}>Done</button></div>
    </div>
  </Modal>;
}

function RelatedHomework({ api, id }: { api: Api; id: string }) {
  const [assignment, setAssignment] = useState<Row | null>(null), [error, setError] = useState("");
  useEffect(() => { let cancelled = false; api(`learning/v1/portal/assignments/${id}`).then(data => { if (!cancelled) setAssignment(data.item); }).catch(e => { if (!cancelled) setError(errorMessage(e)); }); return () => { cancelled = true; }; }, [api, id]);
  return <section><h3>Related homework</h3><Notice error={error} />{assignment ? <p>{assignment.title}</p> : !error && <p className="crm-helper">Loading homework…</p>}<p className="crm-helper">Submit your work in Homework. Completing a planning checklist does not submit the assignment.</p></section>;
}

function StudentBoardCardEditor({ api, business, studentId, board, columns, card, canWrite, onClose, onSaved }: { api: Api; business: Business; studentId: string; board: Row; columns: Row[]; card: Row; canWrite: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const canReadLearning = business.entitlements.includes("learning") && hasPermission(business, "learning.read");
  const [title, setTitle] = useState(card.title ?? ""), [description, setDescription] = useState(card.description ?? ""), [checklist, setChecklist] = useState<Row[]>(card.checklist ?? []), [references, setReferences] = useState<Row[]>(card.references ?? []);
  const [deadline, setDeadline] = useState<Row | null>(card.deadline ? { ...card.deadline } : null), [deadlineChanged, setDeadlineChanged] = useState(false), [dateConfirmed, setDateConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [deleting, setDeleting] = useState(false), [confirmDelete, setConfirmDelete] = useState(false), [requestKey] = useState(() => crypto.randomUUID());
  const [assignmentId, setAssignmentId] = useState(card.learningAssignmentId ?? ""), [assignmentChanged, setAssignmentChanged] = useState(false);
  function updateDeadline(patch: Row) { setDeadline((value) => ({ ...value, ...patch })); setDeadlineChanged(true); setDateConfirmed(false); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canWrite) return; setBusy(true); setError("");
    try {
      if (checklist.some((row) => !row.text.trim())) throw new Error("Give each checklist item a name or remove it.");
      if (references.some((row) => !row.label?.trim() || (row.kind === "learning_resource" ? !row.resourceId : !publicLink(row.url)))) throw new Error("Each reference needs a label and an HTTPS link or resource ID.");
      const payload: Row = { title: title.trim(), description, checklist, references };
      if (!card.id || assignmentChanged) payload.learningAssignmentId = assignmentId.trim() || null;
      if (!card.id || deadlineChanged) {
        if (deadline) {
          try { new Intl.DateTimeFormat("en", { timeZone: deadline.timeZone }); } catch { throw new Error("Choose a valid deadline timezone, such as Europe/London."); }
          if (deadline.dueAt && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(deadline.dueAt) || Number.isNaN(Date.parse(deadline.dueAt)))) throw new Error("Use an ISO date with a timezone offset, or leave the unknown date blank.");
          if (deadline.kind === "official" && !dateConfirmed) throw new Error("Confirm the deadline and its source, or confirm that its date remains unknown.");
          const sourceUrls = (deadline.sourceUrls ?? []).map((url: string) => url.trim()).filter(Boolean);
          if (sourceUrls.some((url: string) => !publicLink(url)) || (deadline.kind === "official" && !sourceUrls.length)) throw new Error("Official deadlines require at least one HTTPS source link.");
          payload.deadline = { kind: deadline.kind, dueAt: deadline.dueAt || null, timeZone: deadline.timeZone, sourceUrls, cycle: deadline.cycle || null, round: deadline.round || null, applicability: deadline.applicability ?? "" };
        } else payload.deadline = null;
      }
      if (card.id) await api(`planning/v1/cards/${card.id}`, "PATCH", { ...payload, expectedRevision: card.revision });
      else await api(`planning/v1/boards/${board.id}/cards`, "POST", { ...payload, expectedBoardRevision: board.revision, columnId: card.columnId ?? columns[0]?.id, position: card.position ?? 0 }, requestKey);
      await onSaved(); onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove() { if (!confirmDelete || !canWrite) return; setBusy(true); setError(""); try { await api(`planning/v1/cards/${card.id}`, "DELETE", { expectedRevision: card.revision }); await onSaved(); onClose(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  let dateInput = ""; try { dateInput = zonedDateInput(deadline?.dueAt, deadline?.timeZone ?? "UTC"); } catch {}
  return <Modal title={card.id ? "Edit planning task" : "Add planning task"} onClose={() => { if (!busy) onClose(); }}><Notice error={error} /><form onSubmit={(e) => void submit(e)}><fieldset disabled={busy || !canWrite} className="crm-record-fieldset"><label>Task name<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label><label>Details<textarea maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} rows={4} /></label>
    <h3>Checklist</h3><div className="student-board-checklist">{checklist.map((row, index) => <div className="student-board-checklist-row" key={row.id}><input aria-label={`Complete checklist item ${index + 1}`} type="checkbox" checked={row.done} onChange={(e) => setChecklist((items) => items.map((item) => item.id === row.id ? { ...item, done: e.target.checked } : item))} /><input aria-label={`Checklist item ${index + 1}`} type="text" required maxLength={500} value={row.text} onChange={(e) => setChecklist((items) => items.map((item) => item.id === row.id ? { ...item, text: e.target.value } : item))} />{canWrite && <button type="button" aria-label={`Remove checklist item ${index + 1}`} onClick={() => setChecklist((items) => items.filter((item) => item.id !== row.id))}>Remove</button>}</div>)}</div>{canWrite && <button type="button" disabled={checklist.length >= 100} onClick={() => setChecklist((rows) => [...rows, { id: crypto.randomUUID(), text: "", done: false }])}>Add checklist item</button>}
    <h3>References</h3><p className="crm-helper">Google Docs sharing is managed by Google. A planning task does not submit or complete homework.</p><div className="student-board-links">{references.map((row, index) => <div key={index} className="student-template-scope"><div className="form-grid"><label>Type<select value={row.kind} onChange={(e) => setReferences((items) => items.map((item, at) => at === index ? { kind: e.target.value, label: item.label, ...(e.target.value === "learning_resource" ? { resourceId: "" } : { url: "" }) } : item))}><option value="link">External link</option><option value="google_doc">Google document</option>{canReadLearning && <option value="learning_resource">Learning resource</option>}</select></label><label>Label<input required maxLength={200} value={row.label} onChange={(e) => setReferences((items) => items.map((item, at) => at === index ? { ...item, label: e.target.value } : item))} /></label></div>{row.kind === "learning_resource" ? <LearningReferencePicker api={api} studentId={studentId} kind="resources" allowed={canReadLearning} value={row.resourceId ?? ""} label="Learning resource" onChange={(id) => setReferences((items) => items.map((item, at) => at === index ? { ...item, resourceId: id } : item))} /> : <label>HTTPS URL<input required value={row.url ?? ""} onChange={(e) => setReferences((items) => items.map((item, at) => at === index ? { ...item, url: e.target.value } : item))} /></label>}{row.url && publicLink(row.url) && <a href={row.url} target="_blank" rel="noopener noreferrer">Open reference ↗</a>}{canWrite && <button type="button" onClick={() => setReferences((items) => items.filter((_, at) => at !== index))}>Remove reference</button>}</div>)}</div>{canWrite && <button type="button" disabled={references.length >= 30} onClick={() => setReferences((rows) => [...rows, { kind: "link", label: "", url: "" }])}>Add reference</button>}
    <LearningReferencePicker api={api} studentId={studentId} kind="assignments" allowed={canReadLearning} value={assignmentId} label="Related homework (optional)" onChange={(id) => { setAssignmentId(id); setAssignmentChanged(true); }} /><p className="crm-helper">This is a reference only. Moving a card does not change homework status.</p>
    <h3>Deadline</h3>{card.deadline && !deadlineChanged && <DeadlineLabel deadline={card.deadline} />}{deadline ? <div className="student-board-deadline">
      <DatePicker name="taskDueAt" label="Due date (optional)" withTime value={dateInput} disabled={busy || !canWrite} onChange={value => { try { updateDeadline({ dueAt: zonedDateInstant(value, deadline.timeZone) }); setError(""); } catch (e) { setError(errorMessage(e)); } }} />
      <p className="crm-helper">Time is shown in {deadline.timeZone}.</p>
      <label>Deadline type<select value={deadline.kind} onChange={event => updateDeadline({ kind: event.target.value })}><option value="personal">Personal milestone</option><option value="official">Official deadline</option></select></label>
      <details className="planning-task-advanced" open={deadline.kind === "official" || undefined}><summary>Timezone & official deadline details</summary>
        <label>Timezone<input required value={deadline.timeZone} onChange={event => updateDeadline({ timeZone: event.target.value })} placeholder="Europe/London" /></label>
        {deadline.kind === "official" && <><div className="form-grid"><label>Entry cycle<input type="number" min={2027} max={2200} value={deadline.cycle ?? ""} onChange={event => updateDeadline({ cycle: event.target.value ? Number(event.target.value) : null })} /></label><label>Round<input maxLength={100} value={deadline.round ?? ""} onChange={event => updateDeadline({ round: event.target.value || null })} /></label></div><label>Who this applies to<textarea maxLength={2000} value={deadline.applicability ?? ""} onChange={event => updateDeadline({ applicability: event.target.value })} /></label><label>Official source links (one per line)<textarea rows={3} value={(deadline.sourceUrls ?? []).join("\n")} onChange={event => updateDeadline({ sourceUrls: event.target.value.split("\n") })} /></label></>}
      </details>
      {deadline.kind === "official" && (!card.id || deadlineChanged) && <label className="student-board-checklist-row"><input type="checkbox" checked={dateConfirmed} onChange={event => setDateConfirmed(event.target.checked)} />{deadline.dueAt ? "I checked this official date, timezone and applicability." : "This official date is unknown and must be checked."}</label>}
      {canWrite && <button type="button" onClick={() => { setDeadline(null); setDeadlineChanged(true); }}>Remove deadline</button>}
    </div> : canWrite && <button type="button" onClick={() => { setDeadline({ kind: "personal", dueAt: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", sourceUrls: [], cycle: null, round: null, applicability: "" }); setDeadlineChanged(true); }}>Add deadline or milestone</button>}

  </fieldset><div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Close</button>{canWrite && <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save task"}</button>}</div></form>{references.filter((reference) => reference.kind === "learning_resource").map((reference, index) => <ResourcePreview key={`${reference.resourceId}:${index}`} api={api} business={business} allowed={canReadLearning} reference={reference} />)}{card.id && canWrite && <div className="student-board-danger">{deleting ? <><label className="student-board-checklist-row"><input type="checkbox" checked={confirmDelete} onChange={(e) => setConfirmDelete(e.target.checked)} />Delete this task and its checklist permanently.</label><button disabled={!confirmDelete || busy} onClick={() => void remove()}>Confirm delete task</button><button disabled={busy} onClick={() => setDeleting(false)}>Cancel</button></> : <button onClick={() => setDeleting(true)}>Delete task</button>}</div>}</Modal>;
}

function LearningReferencePicker({ api, studentId, kind, allowed, value, label, onChange }: { api: Api; studentId: string; kind: "resources" | "assignments"; allowed: boolean; value: string; label: string; onChange: (id: string) => void }) {
  const [items, setItems] = useState<Row[]>([]), [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  useEffect(() => { let cancelled = false; if (!allowed) return; setLoading(true); setError(""); api(`learning/v1/portal/${kind}?${new URLSearchParams({ clientId: studentId, limit: "50", offset: String(offset) })}`).then((data) => { if (!cancelled) { setItems(data.items ?? []); setTotal(data.total ?? 0); } }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [api, studentId, kind, offset, allowed]);
  if (!allowed) return value ? <p className="crm-helper">A learning reference is attached. Your current access does not allow opening it.</p> : null;
  return <div><Notice error={error} /><label>{label}<select disabled={loading} value={value} onChange={(e) => onChange(e.target.value)}><option value="">No reference</option>{value && !items.some((row) => row.id === value) && <option value={value}>Current attached reference</option>}{items.map((row) => <option value={row.id} key={row.id}>{row.title}</option>)}</select></label>{total > 50 && <div className="student-boards-actions"><button type="button" disabled={loading || offset === 0} onClick={() => setOffset((at) => Math.max(0, at - 50))}>Previous references</button><span>{offset + 1}–{Math.min(offset + 50, total)} of {total}</span><button type="button" disabled={loading || offset + 50 >= total} onClick={() => setOffset((at) => at + 50)}>Next references</button></div>}</div>;
}

function ResourcePreview({ api, business, allowed, reference }: { api: Api; business: Business; allowed: boolean; reference: Row }) {
  const [resource, setResource] = useState<Row | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function open() { if (!allowed) return; setBusy(true); setError(""); try { const result = await api(`learning/v1/portal/resources/${reference.resourceId}`); setResource(result.item); if (!result.item.url) await downloadFile(`learning/v1/portal/resources/${reference.resourceId}/download`, business.id, result.item.fileName ?? result.item.title); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <div className="student-template-scope"><strong>{reference.label}</strong><Notice error={error} />{allowed ? <><button disabled={busy} type="button" onClick={() => void open()}>{busy ? "Opening…" : "Open attached learning resource"}</button>{resource?.url && publicLink(resource.url) && <a href={resource.url} target="_blank" rel="noopener noreferrer">{resource.title} ↗</a>}{resource?.sharingNotice && <p className="crm-helper">{resource.sharingNotice}</p>}</> : <p className="crm-helper">Learning access is required to open this resource.</p>}</div>;
}
