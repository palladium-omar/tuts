import { useEffect, useState, type FormEvent } from "react";
import { Download, FileText, Plus, Upload, X } from "lucide-react";
import {
  date,
  downloadFile,
  errorMessage,
  type Api,
  type Row,
} from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import "./teaching-ux.css";
import { DatePicker } from "../components/date-picker";

const assignmentStatus: Record<string, string> = {
  assigned: "Assigned",
  submitted: "Ready for review",
  completed: "Completed",
  needs_revision: "Needs another attempt",
};
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export function Learning({
  api,
  businessId,
  onOpenClients,
  initialStudentId,
}: {
  api: Api;
  businessId: string;
  onOpenClients?: () => void;
  initialStudentId?: string;
}) {
  const [studentId, setStudentId] = useState("");
  const [filterStudentId, setFilterStudentId] = useState(initialStudentId ?? "");
  const [documents, setDocuments] = useState<{ title: string; url: string }[]>([]);
  useEffect(() => { setFilterStudentId(initialStudentId ?? ""); }, [initialStudentId]);
  const [rows, setRows] = useState<Row[]>([]),
    [students, setStudents] = useState<Row[]>([]),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<Row | null>(null),
    [files, setFiles] = useState<File[]>([]),
    [uploaded, setUploaded] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [opening, setOpening] = useState(false),
    [saveStep, setSaveStep] = useState(""),
    [loading, setLoading] = useState(true);
  async function loadStudents() {
    const all: Row[] = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const result = await api(
        `clients/v1/clients?kind=student&limit=100&offset=${offset}`,
      );
      all.push(...result.items);
      if (result.items.length < 100) break;
    }
    if (filterStudentId && !all.some((student) => student.id === filterStudentId)) {
      const selectedStudent = await api(`clients/v1/clients/${filterStudentId}`);
      if (selectedStudent.item?.kind === "student") all.push(selectedStudent.item);
    }
    setStudents(all);
    return all;
  }
  async function load() {
    setLoading(true);
    try {
      const data = await api(`learning/v1/assignments?${new URLSearchParams({ limit: "200", ...(filterStudentId ? { clientId: filterStudentId } : {}) })}`);
      setRows(data.items);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api(`learning/v1/assignments?${new URLSearchParams({ limit: "200", ...(filterStudentId ? { clientId: filterStudentId } : {}) })}`).then((data) => { if (!cancelled) { setRows(data.items); setError(""); } }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    void loadStudents().catch(() => setStudents([]));
    return () => { cancelled = true; };
  }, [api, filterStudentId]);
  async function openCreate() {
    setError("");
    setMessage("");
    setOpening(true);
    try {
      await loadStudents();
      setFiles([]);
      setUploaded([]);
      setDocuments([]);
      setStudentId(filterStudentId);
      setCreating(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const attachments = [...uploaded];
    try {
      for (const document of documents) {
        let url: URL;
        try { url = new URL(document.url); } catch { throw new Error("Use a valid Google Docs document URL."); }
        if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || !/^\/document\/d\/[A-Za-z0-9_-]+(?:\/|$)/.test(url.pathname) || url.username || url.password) throw new Error("Use an HTTPS Google Docs document URL from docs.google.com/document/d/…");
        if (attachments.some((attachment) => attachment.documentUrl === document.url)) continue;
        setSaveStep("Saving selected Google Docs references…");
        const { item } = await api("learning/v1/resources", "POST", { clientId: String(form.get("clientId")), title: document.title.trim(), kind: "google_doc", url: url.href });
        attachments.push({ ...item, documentUrl: document.url }); setUploaded([...attachments]);
      }
      for (const [index, file] of files.entries()) {
        if (attachments.some((a) => a.uploadFile === file)) continue;
        setSaveStep(`Uploading file ${index + 1} of ${files.length}…`);
        const body = new FormData();
        body.set("clientId", String(form.get("clientId")));
        body.set("title", file.name);
        body.set("file", file);
        const { item } = await api(
          "learning/v1/resources/upload",
          "POST",
          body,
        );
        attachments.push({
          ...item,
          uploadName: file.name,
          uploadSize: file.size,
          uploadFile: file,
        });
        setUploaded([...attachments]);
      }
      setSaveStep("Saving assignment…");
      await api("learning/v1/assignments", "POST", {
        clientId: form.get("clientId"),
        title: form.get("title"),
        description: form.get("description") || "",
        resourceIds: attachments.map((a) => a.id),
        ...(form.get("dueAt")
          ? { dueAt: new Date(String(form.get("dueAt"))).toISOString() }
          : {}),
      });
      setCreating(false);
      setFiles([]);
      setUploaded([]);
      setDocuments([]);
      await load();
      setMessage(
        attachments.length
          ? "Assignment saved with its files."
          : "Assignment saved.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setSaveStep("");
    }
  }
  async function download(resource: Row) {
    try {
      await downloadFile(
        `learning/v1/resources/${resource.id}/download`,
        businessId,
        resource.fileName ?? resource.title,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function progress(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const f = new FormData(e.currentTarget);
    const review = selected.status === "submitted";
    setBusy(true);
    setError("");
    try {
      await api(
        `learning/v1/assignments/${selected.id}/${review ? "review" : "submit"}`,
        "POST",
        review
          ? { status: f.get("status"), feedback: f.get("feedback") || "" }
          : { submissionText: f.get("submissionText") },
      );
      setSelected(null);
      await load();
      setMessage(review ? "Review saved." : "Submission recorded.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Give every student a clear next step.</h1>
          <p className="muted">
            Assign worksheets, PDFs, and learning materials. Keep submissions
            and feedback alongside the work.
          </p>
        </div>
        <button
          className="primary"
          disabled={opening}
          onClick={() => void openCreate()}
        >
          <Plus size={16} />
          {opening ? "Loading students…" : "New assignment"}
        </button>
      </div>
      <Notice error={!creating && !selected ? error : ""} message={message} />
      <section className="panel">
        <div className="panel-title">
          <h3>Assignments & materials</h3>
          <label>Student<select aria-label="Filter assignments by student" value={filterStudentId} onChange={(e) => setFilterStudentId(e.target.value)}><option value="">All students</option>{students.map((student) => <option value={student.id} key={student.id}>{student.displayName}</option>)}</select></label>
          <span className="tag">
            {rows.length} {rows.length === 1 ? "assignment" : "assignments"}
          </span>
        </div>
        {loading ? (
          <Empty>Loading assignments…</Empty>
        ) : !rows.length ? (
          <Empty>
            <FileText size={30} />
            <h3>Your students’ work belongs here.</h3>
            <p>Add an assignment and attach the resources they need.</p>
          </Empty>
        ) : (
          <div className="assignment-grid">
            {rows.map((row) => (
              <article className="assignment-card" key={row.id}>
                <div className="panel-title">
                  <strong>{row.title}</strong>
                  <span className={`status ${row.status}`}>
                    {assignmentStatus[row.status] ?? row.status}
                  </span>
                </div>
                <p className="teaching-student">
                  {students.find((s) => s.id === row.clientId)?.displayName ??
                    "Student unavailable"}
                </p>
                {row.description && <p>{row.description}</p>}
                {row.dueAt && (
                  <small className="muted">Due {date(row.dueAt)}</small>
                )}
                <div className="attachment-list">
                  {row.resources?.map((r: Row) => (
                    r.kind === "google_doc" || r.kind === "link" ? <a key={r.id} href={r.url} target="_blank" rel="noopener noreferrer" className="chosen-file"><FileText size={16} /><span>{r.title}<small>{r.sharingNotice ?? "Google sharing permissions still apply."}</small></span>Open document</a> : <button
                      key={r.id}
                      disabled={r.storageStatus !== "stored"}
                      onClick={() => void download(r)}
                    >
                      <FileText size={16} />
                      <span>{r.fileName ?? r.title}</span>
                      <Download size={15} />
                    </button>
                  ))}
                </div>
                {row.feedback && (
                  <blockquote>
                    <strong>Feedback</strong>
                    <p>{row.feedback}</p>
                  </blockquote>
                )}
                <button
                  className="link"
                  onClick={() => {
                    setSelected(row);
                    setError("");
                  }}
                >
                  View work & progress
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      {creating && (
        <Modal
          title="New assignment"
          onClose={() => {
            if (!busy) setCreating(false);
          }}
        >
          <Notice error={error} />
          {!students.length ? (
            <div className="teaching-prerequisite">
              <FileText size={28} />
              <h3>Add a student first</h3>
              <p>
                Assignments belong to a student. Add a contact in CRM and choose
                Student as their relationship, then return here.
              </p>
              {onOpenClients && (
                <button
                  className="primary"
                  onClick={() => {
                    setCreating(false);
                    onOpenClients();
                  }}
                >
                  Open CRM
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={create}>
              <div className="form-grid">
                <label>
                  Student
                  <select
                    name="clientId"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                    required
                    disabled={busy || uploaded.length > 0}
                  >
                    <option value="">Choose a student</option>
                    {students.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayName}
                      </option>
                    ))}
                  </select>
                  {uploaded.length > 0 && (
                    <input type="hidden" name="clientId" value={studentId} />
                  )}
                </label>
                <label>
                  Assignment title
                  <input
                    name="title"
                    required
                    maxLength={200}
                    disabled={busy}
                    placeholder="For example: Algebra practice"
                  />
                </label>
                <div>
                  <DatePicker
                    name="dueAt"
                    label="Due date (optional)"
                    withTime
                    disabled={busy}
                  />
                  <small className="field-hint">
                    Time is shown in{" "}
                    {Intl.DateTimeFormat().resolvedOptions().timeZone}. New
                    dates default to 23:59.
                  </small>
                </div>
              </div>
              <label className="file-drop">
                <Upload size={28} />
                <strong>Add learning materials</strong>
                <span>
                  PDF, Word, PowerPoint, images, or text · up to 20 MB per file
                </span>
                <input
                  type="file"
                  multiple
                  disabled={busy}
                  accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.txt"
                  aria-label="Choose learning material files"
                  onChange={(e) => {
                    const incoming = [...(e.target.files ?? [])].filter(
                      (file, index, incomingFiles) =>
                        !files.some(
                          (existing) =>
                            existing.name === file.name &&
                            existing.size === file.size &&
                            existing.lastModified === file.lastModified,
                        ) &&
                        incomingFiles.findIndex(
                          (other) =>
                            other.name === file.name &&
                            other.size === file.size &&
                            other.lastModified === file.lastModified,
                        ) === index,
                    );
                    e.target.value = "";
                    if (incoming.some((f) => f.size > 20 * 1024 * 1024)) {
                      setError("Each attachment must be 20 MB or smaller.");
                      return;
                    }
                    if (files.length + incoming.length + documents.length > 20) {
                      setError("Attach up to 20 files and document references per assignment.");
                      return;
                    }
                    setFiles([...files, ...incoming]);
                    setError("");
                  }}
                />
              </label>
              <div className="attachment-list">
                {files.map((file, i) => (
                  <div className="chosen-file" key={`${file.name}-${i}`}>
                    <FileText size={17} />
                    <span>
                      {file.name}
                      <small>
                        {fileSize(file.size)}
                        {uploaded.some((r) => r.uploadFile === file)
                          ? " · uploaded"
                          : ""}
                      </small>
                    </span>
                    <button
                      type="button"
                      disabled={
                        busy || uploaded.some((r) => r.uploadFile === file)
                      }
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setFiles(files.filter((_, j) => i !== j))}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <section className="student-contact-form"><h3>Selected Google Docs</h3><p className="crm-helper">Add documents you want this student to use. Google controls sharing; a saved link does not give the student permission to open the document. Creating a new Google Doc through Tuts is not available.</p>{documents.map((document, index) => <div className="form-grid" key={index}><label>Document title<input required maxLength={200} disabled={busy || uploaded.some((item) => item.documentUrl === document.url)} value={document.title} onChange={(e) => setDocuments(documents.map((item, at) => at === index ? { ...item, title: e.target.value } : item))} /></label><label>Google Docs URL<input required type="url" maxLength={2000} disabled={busy || uploaded.some((item) => item.documentUrl === document.url)} value={document.url} placeholder="https://docs.google.com/document/d/…/edit" onChange={(e) => setDocuments(documents.map((item, at) => at === index ? { ...item, url: e.target.value } : item))} /></label><button type="button" disabled={busy || uploaded.some((item) => item.documentUrl === document.url)} onClick={() => setDocuments(documents.filter((_, at) => at !== index))}>Remove document</button></div>)}<button type="button" disabled={busy || documents.length + files.length >= 20} onClick={() => setDocuments([...documents, { title: "", url: "" }])}>Add Google Docs reference</button></section>
              <label>
                Note for the student (optional)
                <textarea
                  name="description"
                  rows={3}
                  placeholder="For example: complete questions 1–12 in the attached worksheet."
                  maxLength={5000}
                  disabled={busy}
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
                <button className="primary" disabled={busy}>
                  {busy
                    ? saveStep || "Saving assignment…"
                    : "Create assignment"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {selected && (
        <Modal
          title={selected.title}
          onClose={() => {
            if (!busy) setSelected(null);
          }}
        >
          <Notice error={error} />
          <div className="teaching-progress-meta">
            <strong>
              {students.find((s) => s.id === selected.clientId)?.displayName ??
                "Student unavailable"}
            </strong>
            <span className={`status ${selected.status}`}>
              {assignmentStatus[selected.status] ?? selected.status}
            </span>
            {selected.dueAt && (
              <small className="muted">Due {date(selected.dueAt)}</small>
            )}
          </div>
          {selected.description && (
            <p className="teaching-work-text">{selected.description}</p>
          )}
          <h3 className="teaching-materials-heading">Learning materials</h3>
          {!selected.resources?.length && (
            <p className="muted">No files attached to this assignment.</p>
          )}
          <div className="attachment-list">
            {selected.resources?.map((r: Row) => (
              r.kind === "google_doc" || r.kind === "link" ? <a key={r.id} href={r.url} target="_blank" rel="noopener noreferrer" className="chosen-file"><FileText size={16} /><span>{r.title}<small>{r.sharingNotice ?? "Google sharing permissions still apply."}</small></span>Open document</a> : <button
                key={r.id}
                disabled={r.storageStatus !== "stored"}
                onClick={() => void download(r)}
              >
                <FileText size={16} />
                {r.fileName ?? r.title}
                <Download size={16} />
              </button>
            ))}
          </div>
          {selected.submissionText && (
            <section className="submission">
              <h3>Student work</h3>
              <p className="teaching-work-text">{selected.submissionText}</p>
            </section>
          )}
          {selected.feedback && (
            <blockquote>
              <strong>Feedback</strong>
              <p className="teaching-work-text">{selected.feedback}</p>
            </blockquote>
          )}
          {selected.status === "completed" && (
            <p className="teaching-completed">
              This assignment is complete. The student’s work and your feedback
              are saved above.
            </p>
          )}
          {["assigned", "needs_revision", "submitted"].includes(
            selected.status,
          ) && (
            <form onSubmit={progress}>
              {selected.status === "submitted" ? (
                <>
                  <label>
                    Review
                    <select name="status" disabled={busy}>
                      <option value="completed">Complete</option>
                      <option value="needs_revision">
                        Needs another attempt
                      </option>
                    </select>
                  </label>
                  <label>
                    Feedback
                    <textarea
                      name="feedback"
                      rows={4}
                      maxLength={5000}
                      disabled={busy}
                      placeholder="Share what went well and the next step."
                    />
                  </label>
                </>
              ) : (
                <>
                  <p className="muted">
                    Record work received from this student.
                  </p>
                  <label>
                    Submission / work received
                    <textarea
                      name="submissionText"
                      required
                      rows={4}
                      maxLength={10000}
                      disabled={busy}
                      placeholder="Summarize the work received, or paste the student’s answers."
                    />
                  </label>
                </>
              )}
              <div className="form-actions">
                <button className="primary" disabled={busy}>
                  {busy
                    ? "Saving…"
                    : selected.status === "submitted"
                      ? "Save review"
                      : "Record submission"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
