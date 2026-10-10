import { useEffect, useState } from "react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import { DeadlineLabel, publicLink } from "./student-board-card";

export function StudentBoardTemplateReview({ api, board, cards, columns, onClose, onSaved }: { api: Api; board: Row; cards: Row[]; columns: Row[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [review, setReview] = useState<Row | null>(null), [selected, setSelected] = useState<Set<string>>(new Set()), [added, setAdded] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setReview(null); setSelected(new Set()); setAdded(new Set()); setConfirmed(false); setError("");
    async function load() {
      const template = await api(`planning/v1/templates/${board.templateKey}`, "GET", undefined, undefined, { fresh: true });
      const data = await api(`planning/v1/boards/${board.id}/template-review?version=${template.item.version}`, "GET", undefined, undefined, { fresh: true });
      if (!cancelled) setReview(data);
    }
    load().catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, board.id, board.templateKey]);
  function choose(kind: "deadline" | "task", id: string, checked: boolean) {
    setConfirmed(false);
    const setter = kind === "deadline" ? setSelected : setAdded;
    setter(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  }
  async function apply() {
    if (!review || !confirmed || busy) return;
    setBusy(true); setError("");
    try {
      await api(`planning/v1/boards/${board.id}/template-apply`, "POST", {
        version: review.templateVersion, expectedRevision: review.board.revision,
        cardIds: [...selected], addedCardKeys: [...added],
      });
      await onSaved(); onClose();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  const upToDate = review?.templateVersion === board.templateVersion;
  const additions: Row[] = review?.addedCards ?? [];
  return <Modal title="Review template version" onClose={() => { if (!busy) onClose(); }}>
    <Notice error={error} />
    {loading ? <Empty>Checking the published template version…</Empty> : review && <>
      <p className="crm-helper">Board version {board.templateVersion} · Published version {review.templateVersion}. Select deadline changes and new tasks to apply. Dates edited by users are preserved. Suggested dates still need confirmation for the selected institution.</p>
      {upToDate && !additions.length ? <Empty>This board already uses the latest published version.</Empty> : <>
        {!upToDate && review.suggestions?.length > 0 && <>
          <h3>Deadline changes</h3><button disabled={busy} onClick={() => { setSelected(new Set(review.suggestions.filter((row: Row) => !row.preserveUserEdit).map((row: Row) => row.cardId))); setConfirmed(false); }}>Select all unedited deadlines</button>
          <div className="student-board-checklist">{review.suggestions.map((suggestion: Row) => <div className="student-template-scope" key={suggestion.cardId}>
            <label className="student-board-checklist-row"><input type="checkbox" disabled={busy || suggestion.preserveUserEdit} checked={selected.has(suggestion.cardId)} onChange={event => choose("deadline", suggestion.cardId, event.target.checked)} />{cards.find(card => card.id === suggestion.cardId)?.title ?? "Template task"}</label>
            {suggestion.preserveUserEdit && <p className="crm-helper">User edited this deadline. Its date will be preserved.</p>}
            <p>Current deadline</p>{suggestion.currentDeadline ? <DeadlineLabel deadline={suggestion.currentDeadline} /> : <p className="crm-helper">No deadline</p>}
            <p>Published deadline</p>{suggestion.proposedDeadline ? <DeadlineLabel deadline={suggestion.proposedDeadline} /> : <p className="crm-helper">No deadline</p>}
          </div>)}</div>
        </>}
        {additions.length > 0 && <>
          <h3>New tasks</h3><button disabled={busy} onClick={() => { setAdded(new Set(additions.filter(card => card.destinationColumnId).map(card => card.key))); setConfirmed(false); }}>Select all new tasks</button>
          <p className="crm-helper">Choose the tasks relevant to this student. Selected tasks include the published checklist and resources.</p>
          <div className="student-board-checklist">{additions.map(card => <div className="student-template-scope" key={card.key}>
            <label className="student-board-checklist-row"><input type="checkbox" disabled={busy || !card.destinationColumnId} checked={added.has(card.key)} onChange={event => choose("task", card.key, event.target.checked)} />{card.title}</label>
            <p>{card.description}</p>
            <p className="crm-helper">{card.destinationColumnId ? `Add to ${columns.find(column => column.id === card.destinationColumnId)?.name ?? "the selected board column"}.` : "Add a column to this board before adding template tasks."}</p>
            {card.deadline ? <DeadlineLabel deadline={card.deadline} /> : <p className="crm-helper">No deadline</p>}
            {(card.checklist?.length > 0 || card.references?.length > 0) && <details className="planning-task-advanced"><summary>Checklist and resources</summary>
              {card.checklist?.length > 0 && <ul>{card.checklist.map((item: Row, index: number) => <li key={item.id ?? index}>{item.text}</li>)}</ul>}
              {card.references?.map((reference: Row, index: number) => publicLink(reference.url) ? <a className="student-template-source" key={index} href={reference.url} target="_blank" rel="noopener noreferrer">{reference.label} ↗</a> : <p key={index}>{reference.label}</p>)}
            </details>}
          </div>)}</div>
        </>}
        <label className="student-board-checklist-row"><input disabled={busy} type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I reviewed the dates and applicability. Record version {review.templateVersion}, apply {selected.size} selected deadline change(s) and add {added.size} selected task(s).</label>
        <button className="primary" disabled={busy || !confirmed} onClick={() => void apply()}>{busy ? "Applying selected changes…" : "Confirm selected changes"}</button>
      </>}
    </>}
    <div className="form-actions"><button disabled={busy} onClick={onClose}>Close</button></div>
  </Modal>;
}
