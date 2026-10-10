import { useEffect, useRef, useState } from "react";
import { hasPermission } from "@palladium/contracts";
import { date, downloadFile, errorMessage, money, type Api, type Business, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import { StudentContacts } from "./student-contacts";
import type { CRMField } from "./crm-controls";

export function StudentAvatar({ student }: { student: Row }) {
  return <span className="tracker-avatar">{student.photo ? <img src={student.photo} alt="" /> : String(student.displayName || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>;
}

export function StudentTrackerDetail({ api, business, student: initial, fields, onClose, onChanged, onOpenLearning, onInvite }: { api: Api; business: Business; student: Row; fields: CRMField[]; onClose: () => void; onChanged: () => void; onOpenLearning?: (studentId: string) => void; onInvite: (student: Row) => void }) {
  const [student, setStudent] = useState(initial), [tab, setTab] = useState("contacts"), [rows, setRows] = useState<Row[]>([]), [resources, setResources] = useState<Row[]>([]), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const photoInput = useRef<HTMLInputElement>(null);
  const canWrite = hasPermission(business, "clients.write"), canInvite = hasPermission(business, "platform.invites.manage");
  const available = (domain: string) => business.entitlements.includes(domain) && hasPermission(business, `${domain}.read`);
  const tabs = ["contacts", ...(available("learning") ? ["learning"] : []), ...(available("scheduling") ? ["sessions"] : []), ...(available("billing") ? ["payments"] : []), "activity"];
  const accessKey = tabs.join(",");
  useEffect(() => {
    let cancelled = false; setRows([]); setResources([]); setError("");
    if (!tabs.includes(tab) || !["learning", "sessions", "payments"].includes(tab)) { setLoading(false); return; }
    setLoading(true);
    const encoded = encodeURIComponent(student.id);
    const read = tab === "learning" ? Promise.all([api(`learning/v1/assignments?clientId=${encoded}&limit=200`), api(`learning/v1/resources?clientId=${encoded}&limit=200`)]) : tab === "sessions" ? Promise.all([api(`scheduling/v1/sessions?clientId=${encoded}&limit=200`)]) : Promise.all([api("billing/v1/invoices")]);
    read.then((results) => { if (!cancelled) { setRows((results[0].items ?? []).filter((row: Row) => row.clientId === student.id)); if (results[1]) setResources(results[1].items ?? []); } }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, business.id, student.id, tab, revision, accessKey]);
  async function refreshStudent() { const data = await api(`clients/v1/clients/${student.id}`); setStudent(data.item); onChanged(); }
  async function photo(file: File | null) {
    if (!canWrite) return; setBusy(true); setError("");
    try {
      let value: string | null = null;
      if (file) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 256 * 1024) throw new Error("Choose a PNG, JPEG or WebP image up to 256 KB.");
        value = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("The image could not be read.")); reader.readAsDataURL(file); });
      }
      const data = await api(`clients/v1/clients/${student.id}`, "PATCH", { photo: value }); setStudent(data.item); onChanged();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function download(resource: Row) { setError(""); try { await downloadFile(`learning/v1/resources/${resource.id}/download`, business.id, resource.fileName ?? resource.title); } catch (e) { setError(errorMessage(e)); } }
  return <Modal title={student.displayName} onClose={() => { if (!busy) onClose(); }}>
    <Notice error={error} />
    <div className="tracker-detail-header"><StudentAvatar student={student} /><div><span className={`status ${student.status}`}>{student.status}</span><p className="crm-helper">{student.email || "No primary email"}</p>{canWrite && <div className="tracker-actions"><button disabled={busy} onClick={() => photoInput.current?.click()}>Change photo</button>{student.photo && <button disabled={busy} onClick={() => void photo(null)}>Remove photo</button>}<input ref={photoInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files?.[0]; if (file) void photo(file); e.target.value = ""; }} /></div>}</div></div>
    <dl className="tracker-properties">{student.tags?.length > 0 && <div><dt>Tags</dt><dd>{student.tags.join(", ")}</dd></div>}{student.source && <div><dt>Source</dt><dd>{student.source}</dd></div>}{fields.filter((field) => student.customFields?.[field.id] != null && student.customFields[field.id] !== "").map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{field.type === "boolean" ? student.customFields[field.id] ? "Yes" : "No" : String(student.customFields[field.id])}</dd></div>)}</dl>
    <div className="tracker-detail-tabs" role="tablist" aria-label="Student workspace sections">{tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} disabled={busy} onClick={() => setTab(name)}>{({ contacts: "Contacts", learning: "Learning", sessions: "Sessions", payments: "Payments", activity: "Activity" } as Record<string, string>)[name]}</button>)}</div>
    {tab === "contacts" && <><StudentContacts api={api} student={student} canWrite={canWrite} onBusyChange={setBusy} onChanged={refreshStudent} />{canInvite && <div className="form-actions"><button disabled={busy} onClick={() => onInvite(student)}>Review portal invitations</button></div>}</>}
    {tab === "activity" && <Empty>Activity history is not available yet.</Empty>}
    {tabs.includes(tab) && ["learning", "sessions", "payments"].includes(tab) && <><div className="tracker-actions"><button disabled={loading} onClick={() => setRevision((n) => n + 1)}>Refresh</button>{tab === "learning" && onOpenLearning && <button onClick={() => onOpenLearning(student.id)}>Open learning workspace</button>}</div>{loading ? <Empty>Loading {tab}…</Empty> : <>
      {!rows.length && !error && <Empty>{tab === "learning" ? "No assignments returned for this student." : tab === "sessions" ? "No recorded sessions returned for this student." : "No invoices for this student in the current billing list."}</Empty>}
      <div className="tracker-detail-list">{rows.map((row) => <article className="tracker-detail-item" key={row.id}>
        <h3>{row.title ?? row.number ?? "Invoice"}</h3><span className={`status ${row.status}`}>{({ assigned: "Assigned", submitted: "Ready for review", completed: "Completed", needs_revision: "Needs another attempt" } as Record<string, string>)[row.status] ?? row.status}</span>
        {tab === "learning" && <>{row.description && <p>{row.description}</p>}{row.dueAt && <p className="crm-helper">Due {date(row.dueAt)}</p>}{row.feedback && <p>Feedback: {row.feedback}</p>}</>}
        {tab === "sessions" && <p className="crm-helper">{date(row.startsAt)} – {date(row.endsAt)}{row.subject ? ` · ${row.subject}` : ""}</p>}
        {tab === "payments" && <><p>{Number.isFinite(row.totalMinor) ? money(row.totalMinor, row.currency) : "Amount unavailable"}</p><p className="crm-helper">Invoice status is shown from billing. Confirmed payment transactions are not included in this view.</p></>}
      </article>)}</div>
      {tab !== "payments" && <p className="crm-helper">Showing up to 200 records returned by this student's {tab === "learning" ? "learning" : "session"} list.</p>}
      {tab === "payments" && <p className="crm-helper">Showing this student's invoices from the recent billing list. Confirmed payment and refund history is not available in this view yet.</p>}
      {tab === "learning" && <><h3>Learning resources</h3>{!resources.length && !error && <p className="crm-helper">No resources returned for this student.</p>}<div className="tracker-detail-list">{resources.map((resource) => <div className="tracker-detail-item" key={resource.id}><strong>{resource.title}</strong><div className="tracker-actions">{resource.kind === "link" && resource.url ? <a href={resource.url} target="_blank" rel="noopener noreferrer">Open document</a> : resource.storageStatus === "stored" ? <button onClick={() => void download(resource)}>Download file</button> : <span className="crm-helper">File metadata only; download unavailable.</span>}</div></div>)}</div></>}
    </>}</>}
  </Modal>;
}
