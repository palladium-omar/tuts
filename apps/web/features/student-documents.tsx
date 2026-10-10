import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, FileText, Plus } from "lucide-react";
import { hasPermission } from "@palladium/contracts";
import { date, errorMessage, type Api, type Business, type Row } from "../lib/api";
import { Empty, Notice } from "../components/shared";

function documentUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "docs.google.com" && !url.port && !url.username && !url.password
      && /^\/document\/d\/[A-Za-z0-9_-]+(?:\/|$)/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function StudentDocuments({ api, business, studentId, onBusyChange }: {
  api: Api; business: Business; studentId: string; onBusyChange: (busy: boolean) => void;
}) {
  const allowed = business.entitlements.includes("learning") && hasPermission(business, "learning.read");
  const canWrite = allowed && hasPermission(business, "learning.write");
  const [documents, setDocuments] = useState<Row[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [creating, setCreating] = useState(false);
  const [title, setTitle] = useState(""), [url, setUrl] = useState("");
  const [loadError, setLoadError] = useState(""), [saveError, setSaveError] = useState(""), [message, setMessage] = useState(""), [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDocuments([]); setLoadError("");
    if (!allowed) { setLoading(false); return; }
    setLoading(true);
    const query = new URLSearchParams({ clientId: studentId, kind: "google_doc", limit: "20", offset: String(offset) });
    api(`learning/v1/resources?${query}`).then((result) => {
      if (!cancelled) { setDocuments(result.items ?? []); setTotal(result.total ?? 0); }
    }).catch((error) => { if (!cancelled) setLoadError(errorMessage(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, allowed, studentId, offset, revision]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || busy) return;
    const link = documentUrl(url);
    if (!link) { setSaveError("Paste a Google Docs document link, such as https://docs.google.com/document/d/…/edit."); return; }
    if (!title.trim()) { setSaveError("Give the essay or document a name."); return; }
    setBusy(true); onBusyChange(true); setSaveError(""); setMessage("");
    try {
      await api("learning/v1/resources", "POST", { clientId: studentId, title: title.trim(), kind: "google_doc", url: link });
      setCreating(false); setTitle(""); setUrl(""); setOffset(0); setRevision((value) => value + 1);
      setMessage("Google Doc saved. The link is also available in this student’s portal resources.");
    } catch (error) { setSaveError(errorMessage(error)); }
    finally { setBusy(false); onBusyChange(false); }
  }

  if (!allowed) return <Empty>Document access is not available with your current permissions.</Empty>;
  return <section className="student-documents" aria-label="Student essays and Google Docs">
    <div className="student-documents-heading"><div><h3>Essays & Google Docs</h3><p className="crm-helper">Keep this student’s essays and shared working documents together.</p></div><div className="tracker-actions"><button disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>Refresh</button>{canWrite && !creating && <button className="primary" onClick={() => { setCreating(true); setSaveError(""); setMessage(""); }}><Plus size={16} /> Add Google Doc</button>}</div></div>
    <Notice error={saveError || loadError} message={message} />
    {creating && canWrite && <form className="student-document-form" onSubmit={save}>
      <h3>Add a Google Doc</h3>
      <fieldset disabled={busy}>
        <label>Essay or document name<input autoFocus required maxLength={200} placeholder="For example: Common App personal statement" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Google Docs link<input required type="url" maxLength={2000} placeholder="https://docs.google.com/document/d/…/edit" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
        <p className="crm-helper">Share the document with the student in Google Docs. Saving this link makes it visible in their Tuts portal; Google controls who can open or edit it.</p>
      </fieldset>
      <div className="form-actions"><button type="button" disabled={busy} onClick={() => { setCreating(false); setSaveError(""); }}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save document link"}</button></div>
    </form>}
    {loading ? <Empty>Loading Google Docs…</Empty> : !loadError && <>
      {!documents.length ? <Empty>{offset ? "No documents on this page." : canWrite ? "No essay links yet. Add a Google Doc to keep it with this student." : "No essay links saved for this student yet."}</Empty> : <div className="tracker-detail-list">{documents.map((document) => {
        const link = documentUrl(document.url ?? "");
        return <article className="tracker-detail-item student-document-card" key={document.id}>
          <FileText size={22} aria-hidden="true" /><div className="student-document-info"><h3>{document.title}</h3><p className="crm-helper">Google Docs{document.createdAt ? ` · Added ${date(document.createdAt)}` : ""}</p>{link && <small className="student-document-url">{link}</small>}</div>
          {link ? <a className="student-document-open" href={link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${document.title} in Google Docs`}>Open document <ExternalLink size={15} /></a> : <span className="crm-helper">Document link unavailable</span>}
        </article>;
      })}</div>}
      {total > 20 && <div className="pagination"><span>{offset + 1}–{Math.min(offset + documents.length, total)} of {total} documents</span><button disabled={busy || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 20))}>Previous</button><button disabled={busy || offset + 20 >= total} onClick={() => setOffset((value) => value + 20)}>Next</button></div>}
      {documents.length > 0 && <p className="crm-helper">Open a document to work together in Google Docs. Its Google sharing settings still apply.</p>}
    </>}
  </section>;
}
