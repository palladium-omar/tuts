import { useEffect, useId, useState } from "react";
import { Search } from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { useListOffset } from "../lib/use-list-query";

export function studentSelectionPath(search: string, offset: number) {
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset / 100) * 100) : 0;
  const query = new URLSearchParams({ kind: "student", limit: "100", offset: String(normalizedOffset), sortBy: "displayName", sortDirection: "asc" });
  if (search.trim()) query.set("search", search.trim().slice(0, 160));
  return `clients/v1/clients?${query}`;
}
export function ServerStudentSelect({ api, value, onChange, onRows, label = "Student", name, required = false, disabled = false, emptyLabel = "Choose a student", selectedName, initiallyOpen = false }: {
  api: Api; value: string; onChange: (id: string) => void; onRows?: (rows: Row[]) => void;
  label?: string; name?: string; required?: boolean; disabled?: boolean; emptyLabel?: string;
  selectedName?: string; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen), [search, setSearch] = useState("");
  const [offset, setOffset] = useListOffset(search);
  const [page, setPage] = useState<{ api: Api; path: string; rows: Row[]; total: number } | null>(null);
  const [resolved, setResolved] = useState<{ api: Api; id: string; row: Row } | null>(null);
  const [loading, setLoading] = useState(initiallyOpen), [error, setError] = useState(""), [lookupError, setLookupError] = useState("");
  const [revision, setRevision] = useState(0), id = useId();
  const path = studentSelectionPath(search, offset), rows = page?.api === api ? page.rows : [];
  const selected = rows.find(row => row.id === value) ?? (resolved?.api === api && resolved.id === value ? resolved.row : null);
  useEffect(() => {
    if (!open || disabled) return;
    let current = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    setLoading(true); setError("");
    const debounce = setTimeout(() => {
      timeout = setTimeout(() => controller.abort(), 20_000);
      void api(path, "GET", undefined, undefined, { signal: controller.signal }).then(data => {
        if (!current || controller.signal.aborted) return;
        setPage({ api, path, rows: data.items ?? [], total: data.total ?? 0 }); onRows?.(data.items ?? []);
      }).catch(e => { if (current) setError(controller.signal.aborted ? "Student search took too long. Retry to search again." : errorMessage(e)); })
        .finally(() => { clearTimeout(timeout); if (current) setLoading(false); });
    }, search ? 250 : 0);
    return () => { current = false; clearTimeout(debounce); clearTimeout(timeout); controller.abort(); };
  }, [api, path, search, open, disabled, onRows, revision]);
  useEffect(() => {
    setLookupError("");
    if (!value || selectedName || selected) return;
    let current = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000);
    void api(`clients/v1/clients/${encodeURIComponent(value)}`, "GET", undefined, undefined, { signal: controller.signal }).then(data => {
      if (!current || controller.signal.aborted) return;
      if (data.item?.kind !== "student") throw new Error("The selected contact is not a student.");
      setResolved({ api, id: value, row: data.item }); onRows?.([data.item]);
    }).catch(e => { if (current) setLookupError(controller.signal.aborted ? "The selected student's name took too long to load." : errorMessage(e)); }).finally(() => clearTimeout(timeout));
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [api, value, selectedName, selected, onRows]);
  const total = page?.api === api ? page.total : 0;
  return <div className="server-student-select">
    <label htmlFor={`${id}-student`}>{label}</label>
    <div className="server-student-field"><select id={`${id}-student`} aria-label={label} name={name} value={value} required={required} disabled={disabled || (open && loading)} onChange={event => onChange(event.target.value)}>
      <option value="">{emptyLabel}</option>
      {value && !rows.some(row => row.id === value) && <option value={value}>{selectedName || selected?.displayName || `Student ${value.slice(0, 8)}`} (selected)</option>}
      {rows.map(row => <option value={row.id} key={row.id}>{row.displayName}</option>)}
    </select><button type="button" aria-expanded={open} aria-controls={`${id}-search`} disabled={disabled} onClick={() => setOpen(current => !current)}><Search size={14} />{open ? "Hide search" : "Find student"}</button></div>
    {(disabled || (open && loading)) && name && <input type="hidden" name={name} value={value} />}
    {open && <div id={`${id}-search`} className="server-student-search"><label htmlFor={`${id}-query`}>Search all students<input id={`${id}-query`} type="search" value={search} maxLength={160} disabled={disabled} placeholder="Name, email or phone" onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} onChange={event => setSearch(event.target.value)} /></label>
      <div className="server-student-pagination"><span role="status">{loading ? "Updating student choices…" : page && page.path !== path ? "Showing previous student choices; retry the search to update them." : total ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total} matching students` : error ? "Student choices could not be loaded." : search ? "No students match this search." : "No students found. Add a student in CRM to create an assignment."}</span><div><button type="button" disabled={disabled || loading || offset === 0} onClick={() => setOffset(current => Math.max(0, current - 100))}>Previous</button><button type="button" disabled={disabled || loading || offset + 100 >= total} onClick={() => setOffset(current => current + 100)}>Next</button></div></div>
      <small>Your selected student stays selected while you search or change pages.</small>
      {error && <div className="server-student-error" role="alert">{error}<button type="button" disabled={disabled || loading} onClick={() => setRevision(current => current + 1)}>Retry</button></div>}
    </div>}
    {lookupError && <small role="alert" className="server-student-error">{lookupError}</small>}
  </div>;
}
