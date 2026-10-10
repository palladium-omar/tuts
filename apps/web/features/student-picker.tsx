import { useEffect, useState } from "react";
import {useListOffset,useListQuery} from "../lib/use-list-query";
import { Search, SlidersHorizontal } from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import { FiltersDialog, type CRMField, type CRMFilter } from "./crm-controls";

export function StudentPicker({ api, groupName, fields, canInvite, onClose, onAdd }: { api: Api; groupName: string; fields: CRMField[]; canInvite: boolean; onClose: () => void; onAdd: (students: Row[], invite: boolean) => Promise<void> }) {
  const [search, setSearch] = useState(""), [sortBy, setSortBy] = useState("displayName"), [sortDirection, setSortDirection] = useState("asc"), [unassigned, setUnassigned] = useState(false), [filters, setFilters] = useState<CRMFilter[]>([]), [filtering, setFiltering] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<Map<string, Row>>(new Map()), [invite, setInvite] = useState(canInvite);
  const filterKey = JSON.stringify({ search, unassigned, filters });
  const [offset,setOffset]=useListOffset(`${filterKey}:${sortBy}:${sortDirection}`);
  const query=new URLSearchParams({kind:'student',limit:'50',offset:String(offset),sortBy,sortDirection});
  if(search)query.set('search',search);if(unassigned)query.set('unassigned','true');if(filters.length)query.set('filters',JSON.stringify(filters));
  const list=useListQuery(api,`clients/v1/clients?${query}`,{delay:search?250:0}),rows:Row[]=list.data?.items||[],total=list.data?.total||0,loading=list.loading;
  function select(row: Row, checked: boolean) { setSelected((current) => { const next = new Map(current); if (checked && next.size < 500) next.set(row.id, row); else if (!checked) next.delete(row.id); return next; }); }
  async function add() { if (!selected.size) return; setBusy(true); setError(""); try { await onAdd([...selected.values()], canInvite && invite); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  if (filtering) return <FiltersDialog selectionHint="Selected students are kept when you change filters." fields={fields} filters={filters} onApply={setFilters} onClose={() => setFiltering(false)} />;
  return <Modal title={`Add students to ${groupName}`} onClose={() => { if (!busy) onClose(); }}>
    <div className="tracker-picker">
      <p className="crm-helper">Choose existing students from the current CRM. Students can belong to more than one group.</p>
      <Notice error={error||list.error} />{loading&&list.data&&<p role="status">Updating students…</p>}
      <div className="toolbar"><label className="search"><Search size={17} /><input aria-label="Search students" placeholder="Name, email or phone" value={search} maxLength={160} disabled={busy} onChange={(e) => setSearch(e.target.value)} /></label><select aria-label="Sort students" value={sortBy} disabled={busy} onChange={(e) => { setSortBy(e.target.value); setOffset(0); }}><option value="displayName">Name</option><option value="createdAt">Date added</option><option value="status">Stage</option>{fields.map((field) => <option value={`custom:${field.id}`} key={field.id}>{field.label}</option>)}</select><button disabled={busy} onClick={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")}>{sortDirection === "asc" ? "Ascending ↑" : "Descending ↓"}</button><button disabled={busy} onClick={() => setFiltering(true)}><SlidersHorizontal size={15} /> Filters{filters.length ? ` (${filters.length})` : ""}</button></div>
      <label className="tracker-check"><input type="checkbox" checked={unassigned} disabled={busy} onChange={(e) => setUnassigned(e.target.checked)} />Only students with no group</label>
      <div className="tracker-picker-count" role="status"><strong>{selected.size} selected across pages · {total} matching students</strong><button disabled={busy || loading || !rows.length || selected.size >= 500} onClick={() => setSelected((current) => { const next = new Map(current); for (const row of rows) { if (next.size >= 500) break; next.set(row.id, row); } return next; })}>Select this page</button><button disabled={busy || !selected.size} onClick={() => setSelected(new Map())}>Clear selection</button></div>
      {selected.size > 0 && <div className="tracker-picked-students" aria-label="Selected students">{[...selected.values()].map(student => <button key={student.id} disabled={busy} aria-label={`Deselect ${student.displayName}`} onClick={() => select(student, false)}>{student.displayName} <span aria-hidden="true">×</span></button>)}</div>}
      {selected.size >= 500 && <p className="crm-helper">Add up to 500 students at a time.</p>}
      {loading&&!list.data ? <Empty>Loading students…</Empty> : !rows.length ? <Empty>No students match these filters.</Empty> : <div className="tracker-picker-list">{rows.map((student) => <label className="tracker-picker-row" key={student.id}><input type="checkbox" checked={selected.has(student.id)} disabled={busy || loading || (!selected.has(student.id) && selected.size >= 500)} onChange={(e) => select(student, e.target.checked)} /><div><strong>{student.displayName}</strong><small>{student.email || "No primary email"}{student.phone ? ` · ${student.phone}` : ""}</small><small>{student.tags?.join(", ")}</small></div><span className={`status ${student.status}`}>{student.status}</span></label>)}</div>}
      {total > 50 && <div className="pagination"><span>{total ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` : "0 matching students"}</span><button disabled={busy || loading || offset === 0} onClick={() => setOffset((n) => Math.max(0, n - 50))}>Previous</button><button disabled={busy || loading || offset + 50 >= total} onClick={() => setOffset((n) => n + 50)}>Next</button></div>}
      {canInvite && <div className="student-contact-warning"><label className="tracker-check"><input type="checkbox" checked={invite} disabled={busy} onChange={(e) => setInvite(e.target.checked)} />Invite to portal after adding</label><p className="crm-helper">You will review student and guardian recipients and confirm delivery in the next step. Existing group memberships do not trigger new invitations.</p></div>}
      <div className="form-actions"><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !selected.size} onClick={() => void add()}>{busy ? "Adding…" : `Add ${selected.size} student${selected.size === 1 ? "" : "s"}`}</button></div>
    </div>
  </Modal>;
}
