import { useEffect, useState, type FormEvent } from "react";
import { FileText, Upload, X } from "lucide-react";
import { date, downloadFile, errorMessage, type Api, type Row } from "../../lib/api";
import { Empty, Modal, Notice } from "../../components/shared";

const labels: Record<string, string> = { assigned: "Assigned", submitted: "Submitted · awaiting tutor review", completed: "Completed", needs_revision: "Needs another attempt" };
function documentUrl(resource: Row) { try { const url = new URL(resource.url); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } }
function Material({ resource, onDownload }: { resource: Row; onDownload: (resource: Row) => void }) {
  const url = documentUrl(resource);
  return <div className="portal-material"><FileText size={18} /><div><strong>{resource.title}</strong>{resource.kind === "google_doc" && <small>{resource.sharingNotice ?? "Google controls access to this document. Ask your tutor to share it with your Google account."}</small>}</div>{["google_doc", "link"].includes(resource.kind) && url ? <a href={url} target="_blank" rel="noopener noreferrer">Open document</a> : resource.storageStatus === "stored" ? <button onClick={() => onDownload(resource)}>Download</button> : <small>Download unavailable</small>}</div>;
}

export function PortalLearning({ api, businessId, studentId, resourcesOnly, canSubmit }: { api: Api; businessId: string; studentId: string; resourcesOnly: boolean; canSubmit: boolean }) {
  const [rows, setRows] = useState<Row[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState(""), [revision, setRevision] = useState(0), [selected, setSelected] = useState<Row | null>(null), [opening, setOpening] = useState(false);
  useEffect(() => { setOffset(0); setRows([]); setSelected(null); setMessage(""); }, [studentId, resourcesOnly]);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError("");
    const query = new URLSearchParams({ clientId: studentId, limit: "20", offset: String(offset) });
    api(`learning/v1/portal/${resourcesOnly ? "resources" : "assignments"}?${query}`).then((data) => { if (!cancelled) { setRows(data.items ?? []); setTotal(data.total ?? 0); } }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, studentId, resourcesOnly, offset, revision]);
  async function download(resource: Row) { setError(""); try { await downloadFile(`learning/v1/portal/resources/${resource.id}/download`, businessId, resource.fileName ?? resource.title); } catch (e) { setError(errorMessage(e)); } }
  async function open(assignment: Row) { setOpening(true); setError(""); try { const data = await api(`learning/v1/portal/assignments/${assignment.id}`); setSelected(data.item); } catch (e) { setError(errorMessage(e)); } finally { setOpening(false); } }
  return <>
    <Notice error={error} message={message} />
    <div className="tracker-actions" style={{ marginBottom: 18 }}><button disabled={loading || opening} onClick={() => setRevision((n) => n + 1)}>Refresh {resourcesOnly ? "resources" : "homework"}</button></div>
    {loading ? <Empty>Loading {resourcesOnly ? "resources" : "homework"}…</Empty> : !rows.length && !error ? <Empty>{resourcesOnly ? "No learning resources have been shared yet." : "No homework has been assigned yet."}</Empty> : resourcesOnly ? <div className="portal-grid">{rows.map((resource) => <article className="portal-card" key={resource.id}><Material resource={resource} onDownload={(item) => void download(item)} /></article>)}</div> : <div className="portal-grid">{rows.map((assignment) => <article className="portal-card" key={assignment.id}><span className={`status ${assignment.status}`}>{labels[assignment.status] ?? assignment.status}</span><h3>{assignment.title}</h3>{assignment.dueAt && <p className="crm-helper">Due {date(assignment.dueAt)}</p>}{assignment.description && <p>{assignment.description}</p>}{assignment.feedback && <blockquote><strong>Tutor feedback</strong><p>{assignment.feedback}</p></blockquote>}<button disabled={opening} onClick={() => void open(assignment)}>Open assignment</button></article>)}</div>}
    <div className="portal-pagination"><span>{total ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` : ""}</span><button disabled={loading || offset === 0} onClick={() => setOffset((n) => Math.max(0, n - 20))}>Previous</button><button disabled={loading || offset + 20 >= total} onClick={() => setOffset((n) => n + 20)}>Next</button></div>
    {selected && <AssignmentWork api={api} assignment={selected} canSubmit={canSubmit} onDownload={(resource) => void download(resource)} onClose={() => setSelected(null)} onSubmitted={() => { setSelected(null); setRevision((n) => n + 1); setMessage("Work submitted. Your tutor will review it before marking the assignment complete."); }} />}
  </>;
}

function AssignmentWork({ api, assignment, canSubmit, onDownload, onClose, onSubmitted }: { api: Api; assignment: Row; canSubmit: boolean; onDownload: (resource: Row) => void; onClose: () => void; onSubmitted: () => void }) {
  const [files, setFiles] = useState<File[]>([]), [uploaded, setUploaded] = useState<Row[]>(assignment.submissionResources ?? []), [busy, setBusy] = useState(false), [step, setStep] = useState(""), [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canSubmit) return; const form = new FormData(event.currentTarget), resources = [...uploaded];
    const submissionText = String(form.get("submissionText") ?? "").trim(), submissionUrl = String(form.get("submissionUrl") ?? "").trim();
    if (!submissionText && !submissionUrl && !files.length && !resources.length) { setError("Add your answers, a work link or a file before submitting."); return; }
    if (submissionUrl) { try { if (new URL(submissionUrl).protocol !== "https:") throw new Error(); } catch { setError("Use an HTTPS link for your work."); return; } }
    setBusy(true); setError("");
    try {
      for (const [index, file] of files.entries()) {
        if (resources.some((resource) => resource.uploadFile === file)) continue;
        setStep(`Uploading file ${index + 1} of ${files.length}…`); const body = new FormData(); body.set("title", file.name); body.set("file", file);
        const data = await api(`learning/v1/portal/assignments/${assignment.id}/submission-upload`, "POST", body); resources.push({ ...data.item, uploadFile: file }); setUploaded([...resources]);
      }
      setStep("Submitting work…"); await api(`learning/v1/portal/assignments/${assignment.id}/submit`, "POST", { ...(submissionText ? { submissionText } : {}), ...(submissionUrl ? { submissionUrl } : {}), submissionResourceIds: resources.map((resource) => resource.id), expectedRevision: assignment.revision }); onSubmitted();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); setStep(""); }
  }
  return <Modal title={assignment.title} onClose={() => { if (!busy) onClose(); }}>
    <Notice error={error} /><span className={`status ${assignment.status}`}>{labels[assignment.status] ?? assignment.status}</span>{assignment.dueAt && <p className="crm-helper">Due {date(assignment.dueAt)}</p>}{assignment.description && <p className="teaching-work-text">{assignment.description}</p>}
    <h3>Learning materials</h3>{assignment.resources?.length ? assignment.resources.map((resource: Row) => <Material key={resource.id} resource={resource} onDownload={onDownload} />) : <p className="crm-helper">No materials attached.</p>}
    {assignment.feedback && <blockquote><strong>Tutor feedback</strong><p className="teaching-work-text">{assignment.feedback}</p></blockquote>}
    {assignment.submissionText && <section><h3>Your last submission</h3><p className="teaching-work-text">{assignment.submissionText}</p></section>}
    {assignment.submissionUrl && <a href={assignment.submissionUrl} target="_blank" rel="noopener noreferrer">Open your submitted work link</a>}
    {assignment.submissionResources?.map((resource: Row) => <Material key={resource.id} resource={resource} onDownload={onDownload} />)}
    {canSubmit && ["assigned", "needs_revision"].includes(assignment.status) ? <form onSubmit={submit}>
      <label>Your answers or notes<textarea name="submissionText" rows={5} maxLength={10000} defaultValue={assignment.submissionText ?? ""} disabled={busy} /></label>
      <label>Work link (optional)<input name="submissionUrl" type="url" maxLength={2000} defaultValue={assignment.submissionUrl ?? ""} placeholder="https://…" disabled={busy} /></label>
      <label className="file-drop"><Upload size={24} /><strong>Attach your work</strong><span>PDF, Word, PowerPoint, images or text · up to 20 MB per file</span><input type="file" multiple accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.txt" disabled={busy} onChange={(e) => { const incoming = Array.from(e.target.files ?? []); e.target.value = ""; const unique = incoming.filter((file) => !files.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)); if (unique.some((file) => file.size > 20 * 1024 * 1024)) { setError("Each file must be 20 MB or smaller."); return; } const oldCount = uploaded.filter((resource) => !resource.uploadFile).length; if (oldCount + files.length + unique.length > 20) { setError("Submit up to 20 files at a time."); return; } setFiles([...files, ...unique]); setError(""); }} /></label>
      <div className="portal-upload-files">{uploaded.filter((resource) => !resource.uploadFile).map((resource) => <div className="portal-upload-file" key={resource.id}><span>{resource.fileName ?? resource.title} · previously uploaded</span><button type="button" disabled={busy} onClick={() => setUploaded(uploaded.filter((item) => item.id !== resource.id))}>Remove from this submission</button></div>)}{files.map((file, index) => <div className="portal-upload-file" key={`${file.name}-${index}`}><span>{file.name}{uploaded.some((resource) => resource.uploadFile === file) ? " · uploaded" : ""}</span><button type="button" aria-label={`Remove ${file.name}`} disabled={busy || uploaded.some((resource) => resource.uploadFile === file)} onClick={() => setFiles(files.filter((_, at) => at !== index))}><X size={16} /></button></div>)}</div>
      <p className="portal-external-notice">Submitting work sends it to your tutor for review. Your tutor decides when the assignment is complete. External documents keep their own sharing permissions.</p>
      <div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>Close</button><button className="primary" disabled={busy}>{busy ? step || "Submitting…" : "Submit work for review"}</button></div>
    </form> : <div className="form-actions"><button onClick={onClose}>Close</button></div>}
  </Modal>;
}
