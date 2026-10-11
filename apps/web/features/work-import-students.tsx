import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { Notice } from '../components/shared';
import { errorMessage, type Api, type Row } from '../lib/api';
import { selectedWorkRows, studentReviewCounts, suggestedStudentDecision, workGroupKey, type StudentDecision } from '../lib/work-import-students';
import { useListQuery } from '../lib/use-list-query';
import './work-import-students.css';

export function WorkImportStudents({ api, importId, onComplete, onClose, onBusyChange }: {
  api: Api; importId: string; onComplete: (message: string) => void; onClose: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [groups, setGroups] = useState<Row[]>([]), [decisions, setDecisions] = useState<Record<string, StudentDecision>>({});
  const [source, setSource] = useState<Row | null>(null), [total, setTotal] = useState(0), [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false), [showLinked, setShowLinked] = useState(false), [revision, setRevision] = useState(0);
  const [searchingGroup, setSearchingGroup] = useState<string | null>(null), [search, setSearch] = useState('');
  const sequence = useRef(0), limit = 500;
  const studentSearch = useListQuery(api, `clients/v1/clients?kind=student&limit=50&offset=0&search=${encodeURIComponent(search)}`, { enabled: Boolean(searchingGroup), delay: search ? 250 : 0, scope: importId });
  useEffect(() => {
    const request = ++sequence.current, controller = new AbortController();
    setLoading(true); setError(''); setAccepted(false); setGroups([]); setDecisions({}); setSearchingGroup(null); setSearch('');
    void (async () => {
      const response = await api(`billing/v1/history-imports/${importId}/students?limit=${limit}&offset=${offset}`, 'GET', undefined, undefined, { signal: controller.signal, fresh: true });
      const item = response.item, rows: Row[] = item.groups;
      // Candidate requests are batched; no request per work row or per student.
      const matches: Row[] = [];
      for (let i = 0; i < rows.length; i += 100) {
        if (controller.signal.aborted) return;
        const result = await api('clients/v1/clients/work-import/preview', 'POST', { importId, groups: rows.slice(i, i + 100).map(group => ({ key: group.key, name: group.name })) }, undefined, { signal: controller.signal });
        matches.push(...result.item.groups);
      }
      if (request !== sequence.current || controller.signal.aborted) return;
      const matchByKey = new Map(matches.map(group => [group.key, group]));
      const combined = rows.map(group => ({ ...group, ...matchByKey.get(group.key) }));
      setSource(item.source); setTotal(item.total); setGroups(combined);
      setDecisions(Object.fromEntries(combined.map(group => [group.key, suggestedStudentDecision(group)])));
    })().catch(e => { if (request === sequence.current && !controller.signal.aborted) setError(errorMessage(e)); })
      .finally(() => { if (request === sequence.current) setLoading(false); });
    return () => { sequence.current++; controller.abort(); };
  }, [api, importId, offset, revision]);
  function update(key: string, patch: Partial<StudentDecision>) {
    setAccepted(false); setDecisions(current => ({ ...current, [key]: { ...current[key], ...patch } }));
  }
  const counts = studentReviewCounts(groups, decisions);
  const allLinked = groups.length > 0 && groups.every(group => group.rows.every((row: Row) => row.identity?.status === 'linked'));
  const visible = groups.filter(group => showLinked || group.rows.some((row: Row) => row.identity?.status !== 'linked'));
  async function save() {
    if (!accepted || saving || loading || !counts.rows) return;
    setSaving(true); onBusyChange?.(true); setError('');
    let linked = 0, replayed = 0;
    try {
      const choices: Row[] = [];
      for (const group of groups) {
        const decision = decisions[group.key];
        if (!decision || decision.action === 'skip') continue;
        const rows = selectedWorkRows(group, decision); if (!rows.length) continue;
        choices.push({ key: await workGroupKey(rows.map(row => row.id)), name: group.name, action: decision.action,
          ...(decision.action === 'link' ? { studentId: decision.studentId } : {}),
          rows: rows.map(row => ({ id: row.id, revision: row.revision, identityRevision: row.identityRevision })) });
      }
      for (let i = 0; i < choices.length; i += 100) {
        const result = await api(`billing/v1/history-imports/${importId}/students`, 'POST', { groups: choices.slice(i, i + 100) });
        linked += result.item.linked; replayed += result.item.replayed;
      }
      onComplete(`Student review saved; ${linked} work ${linked === 1 ? 'record' : 'records'} linked.${replayed ? ` ${replayed} work ${replayed === 1 ? 'record was' : 'records were'} already linked.` : ''} Hours and amounts are unchanged.${offset + limit < total ? ' More records are available in the next page.' : ''}`);
    } catch (e) {
      // Durable source decisions make retry safe even if Clients committed first.
      setError(`${errorMessage(e)} You can retry the same choices safely.`);
    } finally { setSaving(false); onBusyChange?.(false); }
  }
  return <section className="work-student-review" aria-label="Match imported students">
    <div className="work-student-intro"><Users size={22} /><div><h3>Bring these students into your CRM</h3><p>{source?.fileName || 'Your imported work'} · Name-only profiles are supported. Add their contact details whenever you have them.</p></div></div>
    <Notice error={error} />
    {loading ? <p role="status">Finding students and existing matches…</p> : <>
      <div className="work-student-summary"><span><strong>{counts.created}</strong> new profiles</span><span><strong>{counts.linked}</strong> existing students</span><span><strong>{counts.rows}</strong> work records to link</span></div>
      <p className="muted">Review the names before saving. Similar names may describe different people. Use “Review rows” to select only the work that belongs to one student.</p>
      <label className="work-student-check"><input type="checkbox" checked={showLinked} disabled={saving} onChange={e => setShowLinked(e.target.checked)} />Show already linked names</label>
      {searchingGroup && <section className="work-student-search"><h4>Find an existing student for {groups.find(group => group.key === searchingGroup)?.name}</h4><label>Search CRM students<input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, email or phone" /></label><Notice error={studentSearch.error} />{studentSearch.loading && <p role="status">Searching students…</p>}<div>{studentSearch.data?.items.map((student: Row) => <button key={student.id} disabled={saving} onClick={() => { update(searchingGroup, { action: 'link', studentId: student.id }); setGroups(current => current.map(group => group.key === searchingGroup ? { ...group, candidates: [...(group.candidates || []).filter((candidate: Row) => candidate.id !== student.id), student] } : group)); setSearchingGroup(null); }}><strong>{student.displayName}</strong><span>{student.email || 'No email added'}</span></button>)}</div><button onClick={() => setSearchingGroup(null)}>Cancel search</button></section>}
      {!visible.length && !error && <p role="status"><Check size={16} /> All work on this page is linked to CRM students.</p>}
      <div className="work-student-groups">{visible.map(group => {
        const choice = decisions[group.key], fullyLinked = group.rows.every((row: Row) => row.identity?.status === 'linked');
        const selected = choice ? selectedWorkRows(group, choice) : [];
        const dates = group.rows.map((row: Row) => row.date).sort(), earliest = dates[0], latest = dates[dates.length - 1];
        return <article className="work-student-group" key={group.key}>
          <div className="work-student-group-heading"><div><strong>{group.name}</strong><small>{group.rows.length} work records · {earliest}{latest !== earliest ? ` – ${latest}` : ''}</small></div>
            {fullyLinked ? <span className="badge">Linked</span> : <label><span className="sr-only">Student decision for {group.name}</span><select disabled={saving} value={choice?.action === 'link' ? choice.studentId || 'skip' : choice?.action || 'skip'} onChange={e => { if (e.target.value === 'search') {setSearchingGroup(group.key);setSearch('');} else update(group.key, e.target.value === 'create' || e.target.value === 'skip' ? { action: e.target.value, studentId: undefined } : { action: 'link', studentId: e.target.value }); }}>
              {group.resolvedStudentId ? <option value={group.resolvedAction === 'create' ? 'create' : group.resolvedStudentId}>Use previously saved student</option> : <option value="create">Create a student profile</option>}
              {!group.resolvedStudentId && group.candidates?.map((student: Row) => <option value={student.id} key={student.id}>Link to {student.displayName}{student.email ? ` · ${student.email}` : ''}</option>)}
              {!group.resolvedStudentId && <option value="search">Find another existing student…</option>}
              <option value="skip">Leave for later</option>
            </select></label>}
          </div>
          {group.ambiguous && !group.resolvedStudentId && <p className="work-student-warning">Several students have this name. Choose a match, create a separate profile, or leave it for later.</p>}
          {!fullyLinked && group.resolvedStudentId && <small className="muted">The saved profile will be reused. No duplicate student will be added.</small>}
          {!fullyLinked && <details><summary>Review rows · {selected.length} selected</summary><div className="work-student-row-list">{group.rows.map((row: Row) => <label key={row.id}><input type="checkbox" disabled={saving || row.identity?.status === 'linked'} checked={choice?.rowIds.includes(row.id) || false} onChange={e => update(group.key, { rowIds: e.target.checked ? [...choice.rowIds, row.id] : choice.rowIds.filter(id => id !== row.id) })} /><span>{row.date} · {row.serviceType || 'Work'} · {row.hours} h{row.identity?.status === 'linked' ? ' · Already linked' : ''}</span></label>)}</div></details>}
        </article>;
      })}</div>
      {total > limit && <div className="work-student-pagination"><button disabled={saving || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}><ChevronLeft size={16} />Previous</button><span>Records {offset + 1}–{Math.min(total, offset + limit)} of {total}</span><button disabled={saving || offset + limit >= total} onClick={() => setOffset(value => value + limit)}>Next<ChevronRight size={16} /></button></div>}
      {counts.rows > 0 && <label className="work-student-check work-student-confirm"><input type="checkbox" disabled={saving} checked={accepted} onChange={e => setAccepted(e.target.checked)} /><span>I reviewed these names and selected the work that belongs to each student.</span></label>}
    </>}
    <div className="form-actions"><button disabled={saving} onClick={onClose}>{allLinked ? 'Done' : 'Finish later'}</button>{error && !groups.length && <button disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Try again</button>}{!allLinked && <button className="primary" disabled={loading || saving || !accepted || !counts.rows} onClick={() => void save()}>{saving ? 'Adding students and linking work…' : `Save students & link ${counts.rows} records`}</button>}</div>
  </section>;
}
