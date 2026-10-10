import { useEffect, useRef, useState } from "react";
import { canReadFinancial, hasPermission } from "@palladium/contracts";
import { date, downloadFile, errorMessage, type Api, type Business, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import { StudentContacts } from "./student-contacts";
import type { CRMField } from "./crm-controls";
import { StudentFinance } from "./student-finance";
import { StudentReporting } from "./student-reporting";
import { StudentDocuments } from "./student-documents";
import { tutorHomeworkOrder } from "../lib/tutor-workspace";

export function StudentAvatar({ student }: { student: Row }) {
  return <span className="tracker-avatar">{student.photo ? <img src={student.photo} alt="" /> : String(student.displayName || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>;
}

export function StudentTrackerDetail({ api, business, student: initial, fields, month, onMonthChange, onClose, onChanged, onOpenLearning, onOpenPlanning, onInvite, onOpenCRM, initialTab = "summary", onTabChange }: { initialTab?: string; onTabChange?: (tab: string) => void; onOpenCRM?: (studentId: string) => void; api: Api; business: Business; student: Row; fields: CRMField[]; month: string; onMonthChange: (month: string) => void; onClose: () => void; onChanged: () => void; onOpenLearning?: (studentId: string, assignmentId?: string) => void; onOpenPlanning?: (studentId: string) => void; onInvite: (student: Row) => void }) {
  const [student, setStudent] = useState(initial), [tab, setTab] = useState(business.entitlements.includes("reporting") && hasPermission(business, "reporting.read") ? "summary" : "contacts"), [rows, setRows] = useState<Row[]>([]), [resources, setResources] = useState<Row[]>([]), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const photoInput = useRef<HTMLInputElement>(null);
  const canWrite = hasPermission(business, "clients.write"), canInvite = hasPermission(business, "platform.invites.manage");
  const available = (domain: string) => business.entitlements.includes(domain) && hasPermission(business, `${domain}.read`);
  const tabs = [...(available("reporting") ? ["summary"] : []), "contacts", ...(available("learning") ? ["documents", "learning"] : []), ...(available("scheduling") ? ["sessions"] : []), ...(available("billing") && canReadFinancial(business) ? ["payments"] : []), ...(available("reporting") ? ["activity"] : [])];
  const accessKey = tabs.join(",");
  useEffect(() => { setTab(tabs.includes(initialTab) ? initialTab : tabs[0]); }, [initialTab, accessKey]);
  function changeTab(next: string) { setTab(next); onTabChange?.(next); }
  const displayedRows = tab === "learning" ? tutorHomeworkOrder(rows) : rows;
  useEffect(() => {
    let cancelled = false; setRows([]); setResources([]); setError("");
    if (!tabs.includes(tab) || !["learning", "sessions"].includes(tab)) { setLoading(false); return; }
    setLoading(true);
    const encoded = encodeURIComponent(student.id);
    const read = tab === "learning" ? Promise.all([api(`learning/v1/assignments?clientId=${encoded}&limit=200`), api(`learning/v1/resources?clientId=${encoded}&limit=200`)]) : Promise.all([api(`scheduling/v1/portal/sessions?studentId=${encoded}&limit=200`)]);
    read.then((results) => { if (!cancelled) { setRows((results[0].items ?? []).filter((row: Row) => (row.studentId ?? row.clientId) === student.id)); if (results[1]) setResources(results[1].items ?? []); } }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
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
    <div className="tracker-actions tracker-detail-shortcuts">{onOpenCRM && <button disabled={busy} onClick={() => onOpenCRM(student.id)}>{canWrite ? "Edit student record" : "View CRM record"} ↗</button>}{onOpenLearning && <button disabled={busy} onClick={() => onOpenLearning(student.id)}>Assign or review homework ↗</button>}{onOpenPlanning && business.entitlements.includes("planning") && hasPermission(business, "planning.read") && <button disabled={busy} onClick={() => onOpenPlanning(student.id)}>Planning boards ↗</button>}</div><Notice error={error} />
    <div className="tracker-detail-header"><StudentAvatar student={student} /><div><span className={`status ${student.status}`}>{student.status}</span><p className="crm-helper">{student.email || "No primary email"}</p>{canWrite && <div className="tracker-actions"><button disabled={busy} onClick={() => photoInput.current?.click()}>Change photo</button>{student.photo && <button disabled={busy} onClick={() => void photo(null)}>Remove photo</button>}<input ref={photoInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files?.[0]; if (file) void photo(file); e.target.value = ""; }} /></div>}</div></div>
    <dl className="tracker-properties">{student.tags?.length > 0 && <div><dt>Tags</dt><dd>{student.tags.join(", ")}</dd></div>}{student.source && <div><dt>Source</dt><dd>{student.source}</dd></div>}{fields.filter((field) => student.customFields?.[field.id] != null && student.customFields[field.id] !== "").map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{field.type === "boolean" ? student.customFields[field.id] ? "Yes" : "No" : String(student.customFields[field.id])}</dd></div>)}</dl>
    <div className="tracker-detail-tabs" role="tablist" aria-label="Student workspace sections">{tabs.map((name) => <button key={name} role="tab" id={`tracker-tab-${student.id}-${name}`} aria-controls={`tracker-panel-${student.id}`} tabIndex={tab === name ? 0 : -1} aria-selected={tab === name} disabled={busy} onClick={() => changeTab(name)} onKeyDown={event => {
      const at = tabs.indexOf(name), next = event.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(at - 1 + tabs.length) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null;
      if (next) { event.preventDefault(); changeTab(next); document.getElementById(`tracker-tab-${student.id}-${next}`)?.focus(); }
    }}>{({ summary: "Summary", contacts: "Contacts", documents: "Essays & Google Docs", learning: "Learning", sessions: "Sessions", payments: "Payments", activity: "Activity" } as Record<string, string>)[name]}</button>)}</div>
    <div role="tabpanel" id={`tracker-panel-${student.id}`} aria-labelledby={`tracker-tab-${student.id}-${tab}`}>
    {tab === "contacts" && <><StudentContacts api={api} student={student} canWrite={canWrite} onBusyChange={setBusy} onChanged={refreshStudent} />{canInvite && <div className="form-actions"><button disabled={busy} onClick={() => onInvite(student)}>Review portal invitations</button></div>}</>}
    {tabs.includes(tab) && ["summary", "activity"].includes(tab) && <StudentReporting api={api} business={business} studentId={student.id} month={month} onMonthChange={onMonthChange} activityOnly={tab === "activity"} />}
    {tabs.includes(tab) && tab === "payments" && <StudentFinance api={api} business={business} studentId={student.id} />}
    {tabs.includes(tab) && tab === "documents" && <StudentDocuments key={`${business.id}:${student.id}`} api={api} business={business} studentId={student.id} onBusyChange={setBusy} />}
    {tabs.includes(tab) && ["learning", "sessions"].includes(tab) && <><div className="tracker-actions"><button disabled={loading} onClick={() => setRevision((n) => n + 1)}>Refresh</button></div>{loading ? <Empty>Loading {tab}…</Empty> : <>
      {!rows.length && !error && <Empty>{tab === "learning" ? "No assignments returned for this student." : "No recorded sessions returned for this student."}</Empty>}
      <div className="tracker-detail-list">{displayedRows.map((row) => <article className="tracker-detail-item" key={row.id}>
        <h3>{row.title}</h3><span className={`status ${row.status}`}>{({ assigned: "Assigned", submitted: "Ready for review", completed: "Completed", needs_revision: "Needs another attempt", no_show: "No-show", scheduled: "Scheduled", cancelled: "Cancelled" } as Record<string, string>)[row.status] ?? row.status}</span>
        {tab === "learning" && <>{row.description && <p>{row.description}</p>}{row.dueAt && <p className="crm-helper">Due {date(row.dueAt)}</p>}{row.feedback && <p>Feedback: {row.feedback}</p>}{onOpenLearning && <button onClick={() => onOpenLearning(student.id, row.id)}>{row.status === "submitted" ? "Review submitted work" : "Open assignment"} ↗</button>}</>}
        {tab === "sessions" && <p className="crm-helper">{date(row.startsAt)} – {date(row.endsAt)}{row.subject ? ` · ${row.subject}` : ""}</p>}
      </article>)}</div>
      <p className="crm-helper">Showing up to 200 records returned by this student's {tab === "learning" ? "learning" : "session"} list.</p>
      {tab === "learning" && <><h3>Learning resources</h3>{!resources.length && !error && <p className="crm-helper">No resources returned for this student.</p>}<div className="tracker-detail-list">{resources.map((resource) => <div className="tracker-detail-item" key={resource.id}><strong>{resource.title}</strong><div className="tracker-actions">{["link", "google_doc"].includes(resource.kind) && resource.url ? <a href={resource.url} target="_blank" rel="noopener noreferrer">Open document</a> : resource.storageStatus === "stored" ? <button onClick={() => void download(resource)}>Download file</button> : <span className="crm-helper">File metadata only; download unavailable.</span>}</div>{resource.sharingNotice && <p className="crm-helper">{resource.sharingNotice}</p>}</div>)}</div></>}
    </>}</>}
    </div>
  </Modal>;
}
