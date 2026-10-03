import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Download,
  Pencil,
  Plus,
  Search,
  Upload,
  Plug,
  X,
  FileSpreadsheet,
} from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import "./crm.css";
const importFields: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  displayName: "Full / display name",
  email: "Email",
  phone: "Phone",
  kind: "Student or payer",
  status: "CRM status",
  tags: "Tags",
  notes: "Notes",
  source: "Source",
};
const aliases: Record<string, string[]> = {
  firstName: ["firstname", "givenname"],
  lastName: ["lastname", "surname", "familyname"],
  displayName: ["name", "fullname", "displayname", "contactname"],
  email: ["email", "emailaddress", "e-mail"],
  phone: ["phone", "phonenumber", "mobile"],
  kind: ["kind", "type", "clienttype"],
  status: ["status", "lifecycle", "stage"],
  tags: ["tags", "labels"],
  notes: ["notes", "note"],
  source: ["source", "leadsource"],
};
const summaryLabels: Record<string, string> = {
  created: "to add",
  updated: "to update",
  skipped: "skipped",
  errors: "need attention",
};
const actionLabels: Record<string, string> = {
  create: "Add",
  update: "Update",
  skip: "Skip",
  error: "Fix row",
};
export function CRM({ api, onConnect }: { api: Api; onConnect: () => void }) {
  const [rows, setRows] = useState<Row[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("");
  const [editor, setEditor] = useState<Row | null>(null),
    [importing, setImporting] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(
      () => {
        api(
          `clients/v1/clients?limit=50&offset=${offset}&search=${encodeURIComponent(search)}${status ? `&status=${status}` : ""}`,
        )
          .then((data) => {
            if (!cancelled) {
              setRows(data.items);
              setTotal(data.total ?? data.items.length);
              setError("");
            }
          })
          .catch((e) => {
            if (!cancelled) setError(errorMessage(e));
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, search, status, offset, revision]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const firstName = String(f.get("firstName")).trim(),
      lastName = String(f.get("lastName")).trim();
    const displayName =
      String(f.get("displayName") ?? "").trim() ||
      [firstName, lastName].filter(Boolean).join(" ");
    if (!displayName) {
      setError(
        "Add a first name, last name, or display name to identify this contact.",
      );
      e.currentTarget
        .querySelector<HTMLInputElement>('[name="firstName"]')
        ?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        `clients/v1/clients${editor?.id ? `/${editor.id}` : ""}`,
        editor?.id ? "PATCH" : "POST",
        {
          firstName,
          lastName,
          displayName,
          ...(!editor?.id ? { kind: f.get("kind") } : {}),
          email: String(f.get("email") ?? "").trim() || null,
          phone: String(f.get("phone") ?? "").trim() || null,
          status: f.get("status"),
          notes: f.get("notes") || null,
          tags: String(f.get("tags") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          source: String(f.get("source") ?? "").trim() || null,
        },
      );
      setEditor(null);
      setRevision((n) => n + 1);
      setMessage("Contact saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const filtered = Boolean(search || status);
  function clearFilters() {
    setSearch("");
    setStatus("");
    setOffset(0);
  }
  function addContact() {
    setError("");
    setMessage("");
    setEditor({});
  }
  return (
    <div className="crm-workspace">
      <div className="section-heading">
        <div>
          <h1>Your relationships, in one place.</h1>
          <p className="muted">
            Manage students, families, and leads. Bring your existing contacts
            with you.
          </p>
        </div>
        <div className="heading-actions">
          <button onClick={onConnect}>
            <Plug size={16} />
            Sources
          </button>
          <button onClick={() => setImporting(true)}>
            <Upload size={16} />
            Import contacts
          </button>
          <button className="primary" onClick={addContact}>
            <Plus size={16} />
            Add contact
          </button>
        </div>
      </div>
      <Notice error={!editor ? error : ""} message={message} />
      <section className="panel">
        <div className="toolbar">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="Search contacts"
              placeholder="Search names, email, or phone"
              maxLength={160}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
            {search && (
              <button
                className="crm-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setSearch("");
                  setOffset(0);
                }}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <select
            aria-label="Filter contacts by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All stages</option>
            <option value="lead">Leads</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          {filtered && <button onClick={clearFilters}>Clear filters</button>}
          <span className="tag" aria-live="polite">
            {loading
              ? "Searching…"
              : `${total} ${filtered ? "matching " : ""}contact${total === 1 ? "" : "s"}`}
          </span>
        </div>
        {loading ? (
          <Empty>Loading contacts…</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            <h3>
              {filtered
                ? "No contacts match these filters."
                : "Your CRM starts here."}
            </h3>
            <p>
              {filtered
                ? "Try another name or stage, or clear the filters to see all contacts."
                : "Add your first contact or bring your contacts from a spreadsheet."}
            </p>
            <div className="crm-empty-actions">
              {filtered ? (
                <button onClick={clearFilters}>Clear filters</button>
              ) : (
                <>
                  <button className="primary" onClick={addContact}>
                    <Plus size={16} /> Add contact
                  </button>
                  <button onClick={() => setImporting(true)}>
                    <Upload size={16} /> Import spreadsheet
                  </button>
                </>
              )}
            </div>
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="crm-contacts-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Stage</th>
                  <th>Email / phone</th>
                  <th>Source / tags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.displayName}</strong>
                      <small>
                        {row.kind === "payer" ? "Parent / payer" : "Student"}
                      </small>
                    </td>
                    <td>
                      <span className={`status ${row.status}`}>
                        {row.status ?? "active"}
                      </span>
                    </td>
                    <td>
                      {row.email ?? "—"}
                      <small>{row.phone}</small>
                    </td>
                    <td>
                      {row.source === "file-import"
                        ? "Spreadsheet import"
                        : (row.source ?? "Added manually")}
                      <div className="tag-list">
                        {row.tags?.map((tag: string) => (
                          <span className="tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <button
                        aria-label={`Edit ${row.displayName}`}
                        onClick={() => {
                          setError("");
                          setEditor(row);
                        }}
                      >
                        <Pencil size={15} />
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <span>
            {loading
              ? "Loading contacts…"
              : total
                ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}`
                : filtered
                  ? "0 matching contacts"
                  : "No contacts yet"}
          </span>
          <button
            disabled={loading || !offset}
            onClick={() => setOffset((n) => Math.max(0, n - 50))}
          >
            Previous
          </button>
          <button
            disabled={loading || offset + 50 >= total}
            onClick={() => setOffset((n) => n + 50)}
          >
            Next
          </button>
        </div>
      </section>
      {editor && (
        <Modal
          title={editor.id ? "Edit contact" : "Add contact"}
          onClose={() => {
            if (!busy) {
              setEditor(null);
              setError("");
            }
          }}
        >
          <Notice error={error} />
          <p className="crm-helper">
            Provide at least one name. Email and the other details are optional.
          </p>
          <form onSubmit={save}>
            <div className="form-grid">
              <label>
                First name
                <input
                  name="firstName"
                  defaultValue={editor.firstName ?? ""}
                  maxLength={80}
                />
              </label>
              <label>
                Last name
                <input
                  name="lastName"
                  defaultValue={editor.lastName ?? ""}
                  maxLength={80}
                />
              </label>
              <label>
                Display name
                <input
                  name="displayName"
                  defaultValue={editor.displayName ?? ""}
                  maxLength={160}
                  placeholder="Uses first and last name if blank"
                />
              </label>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  maxLength={320}
                  defaultValue={editor.email ?? ""}
                />
              </label>
              <label>
                Phone
                <input
                  name="phone"
                  type="tel"
                  minLength={3}
                  maxLength={40}
                  defaultValue={editor.phone ?? ""}
                />
              </label>
              <label>
                Relationship
                <select
                  name="kind"
                  aria-label="Relationship"
                  defaultValue={editor.kind ?? "student"}
                  disabled={!!editor.id}
                >
                  <option value="student">Student</option>
                  <option value="payer">Parent / payer</option>
                </select>
                {editor.id && (
                  <span className="crm-helper">
                    Relationship is fixed after creation.
                  </span>
                )}
              </label>
              <label>
                Stage
                <select name="status" defaultValue={editor.status ?? "lead"}>
                  <option value="lead">Lead</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <label>
                Source
                <input
                  name="source"
                  maxLength={160}
                  defaultValue={editor.source ?? ""}
                  placeholder="Website, referral, …"
                />
              </label>
              <label>
                Tags
                <input
                  name="tags"
                  aria-label="Tags"
                  defaultValue={editor.tags?.join(", ") ?? ""}
                  placeholder="SAT, math, weekly"
                />
                <span className="crm-helper">Separate tags with commas.</span>
              </label>
            </div>
            <label>
              Notes
              <textarea
                name="notes"
                defaultValue={editor.notes ?? ""}
                rows={3}
                maxLength={4000}
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditor(null);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save contact"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {importing && (
        <ImportContacts
          api={api}
          onClose={() => setImporting(false)}
          onImported={(summary) => {
            setImporting(false);
            clearFilters();
            setRevision((n) => n + 1);
            setMessage(summary);
          }}
        />
      )}
    </div>
  );
}
function ImportContacts({
  api,
  onClose,
  onImported,
}: {
  api: Api;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState<Row | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [mode, setMode] = useState("skip"),
    [preview, setPreview] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [fileName, setFileName] = useState(""),
    [key, setKey] = useState("");
  const reviewing = Boolean(preview);
  useEffect(() => {
    content.current?.closest<HTMLElement>(".modal")?.scrollTo(0, 0);
  }, [reviewing]);
  const payload = () => ({
    rows: sheet?.rows,
    mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
    duplicateMode: mode,
  });
  async function parse(file: File) {
    setBusy(true);
    setError("");
    setPreview(null);
    setSheet(null);
    setFileName(file.name);
    try {
      const form = new FormData();
      form.set("file", file);
      const data = await api("clients/v1/imports/parse", "POST", form);
      setSheet(data.item);
      const initial: Record<string, string> = {};
      for (const [field, options] of Object.entries(aliases)) {
        initial[field] =
          data.item.headers.find((h: string) =>
            options.includes(h.toLowerCase().replace(/[\s_\-]/g, "")),
          ) ?? "";
      }
      setMapping(initial);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    if (!mapping.email) {
      setError(
        "Choose the column containing email addresses before previewing. Email is used to match existing contacts.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await api("clients/v1/imports/preview", "POST", payload());
      setPreview(data.item);
      setKey(crypto.randomUUID());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    setError("");
    try {
      const { item } = await api(
        "clients/v1/imports/commit",
        "POST",
        payload(),
        key,
      );
      if (item.errors?.length) {
        setError(
          `${item.created} added, ${item.updated} updated, ${item.skipped} skipped. ${item.errors.length} rows need attention: ${item.errors
            .slice(0, 3)
            .map(
              (r: Row) =>
                `row ${r.rowNumber}: ${(r.messages ?? r.errors ?? []).join(", ")}`,
            )
            .join("; ")}`,
        );
        setPreview(null);
        setSheet(null);
      } else
        onImported(
          `Import complete: ${item.created} added, ${item.updated} updated, ${item.skipped} skipped.`,
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function template() {
    const url = URL.createObjectURL(
      new Blob(
        [
          "First name,Last name,Email,Phone,Status,Tags\nAlex,Example,alex@example.com,,lead,Math\n",
        ],
        { type: "text/csv" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "tuts-contacts-template.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Modal
      title="Import your contacts"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="crm-import" ref={content}>
        <ol className="crm-import-steps" aria-label="Import progress">
          {["Choose file", "Match columns", "Review & import"].map(
            (label, index) => (
              <li
                key={label}
                aria-current={
                  index === (preview ? 2 : sheet ? 1 : 0) ? "step" : undefined
                }
              >
                <span>{index + 1}</span>
                {label}
              </li>
            ),
          )}
        </ol>
        {!preview && (
          <p className="muted">
            CSV or Excel (.xlsx), up to 5 MB and 2,000 rows. Match your columns,
            review the result, then import. Email identifies duplicates; rows
            without an email are skipped.
          </p>
        )}
        <Notice error={error} />
        {fileName && (
          <div className="crm-file">
            <FileSpreadsheet size={18} />
            <strong>{fileName}</strong>
            <span>
              {busy && !sheet
                ? "Reading file…"
                : sheet
                  ? `${sheet.totalRows} row${sheet.totalRows === 1 ? "" : "s"}`
                  : "Choose a valid file to continue"}
            </span>
          </div>
        )}
        {!preview && (
          <>
            <div className="toolbar">
              <label className="upload-button">
                <Upload size={16} />
                {busy
                  ? "Reading…"
                  : sheet
                    ? "Choose another file"
                    : "Choose spreadsheet"}
                <input
                  type="file"
                  disabled={busy}
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void parse(file);
                    e.target.value = "";
                  }}
                />
              </label>
              <button disabled={busy} onClick={template}>
                <Download size={16} />
                Example CSV
              </button>
            </div>
            {sheet && (
              <>
                <h3>Match your columns</h3>
                <p className="crm-helper">
                  We matched familiar column names. Check each selection against
                  its sample value.
                </p>
                <div className="form-grid mapping-grid">
                  {Object.entries(importFields).map(([field, label]) => (
                    <label key={field}>
                      {label}
                      <select
                        aria-label={label}
                        disabled={busy}
                        value={mapping[field] ?? ""}
                        onChange={(e) => {
                          setMapping({ ...mapping, [field]: e.target.value });
                          setPreview(null);
                        }}
                      >
                        <option value="">Do not import</option>
                        {sheet.headers.map((h: string) => (
                          <option key={h}>{h}</option>
                        ))}
                      </select>
                      {mapping[field] && (
                        <span className="crm-column-sample">
                          Sample:{" "}
                          {String(
                            sheet.rows?.find(
                              (row: Row) => row[mapping[field]],
                            )?.[mapping[field]] ?? "(empty)",
                          )}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <label>
                  When an email already exists
                  <select
                    value={mode}
                    disabled={busy}
                    onChange={(e) => {
                      setMode(e.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="skip">
                      Keep existing contacts, skip duplicates
                    </option>
                    <option value="update">
                      Update matching contacts with non-empty imported values
                    </option>
                  </select>
                </label>
                {!mapping.email && (
                  <p className="crm-helper">
                    Map an email column to continue. Rows without an email can
                    be added manually.
                  </p>
                )}
                <p className="crm-helper">
                  Stage accepts lead, active or inactive. Relationship accepts
                  student or payer. Unmapped values use the contact defaults.
                </p>
                {!preview && (
                  <div className="form-actions">
                    <button
                      className="primary"
                      disabled={busy || !mapping.email}
                      onClick={() => void check()}
                    >
                      {busy ? "Reading…" : "Preview import"}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {preview && (
          <>
            <h3>Review before importing</h3>
            <p className="crm-helper">
              {mode === "skip"
                ? "Existing contacts will be kept. Duplicate emails will be skipped."
                : "Matching contacts will be updated using non-empty values from this file."}{" "}
              Skipped rows and rows with errors will not be imported.
            </p>
            <div className="import-summary">
              {Object.entries(preview.summary ?? {}).map(([name, value]) => (
                <span key={name}>
                  <strong>{String(value)}</strong> {summaryLabels[name] ?? name}
                </span>
              ))}
            </div>
            <div className="table-scroll import-preview">
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Contact</th>
                    <th>Action</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows?.slice(0, 100).map((row: Row) => (
                    <tr key={row.rowNumber}>
                      <td>{row.rowNumber}</td>
                      <td>
                        {row.contact?.displayName ??
                          ([row.contact?.firstName, row.contact?.lastName]
                            .filter(Boolean)
                            .join(" ") ||
                            row.contact?.email ||
                            "—")}
                      </td>
                      <td>
                        <span
                          className={`status ${row.action === "error" ? "inactive" : row.action === "skip" ? "lead" : "active"}`}
                        >
                          {actionLabels[row.action] ?? row.action}
                        </span>
                      </td>
                      <td>
                        {[...(row.errors ?? []), row.message]
                          .filter(Boolean)
                          .join("; ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows?.length > 100 && (
              <p className="small-note">
                Showing the first 100 rows. Summary includes every row.
              </p>
            )}
            {!(preview.summary?.created || preview.summary?.updated) && (
              <p className="crm-helper">
                There are no contacts to add or update. Go back to change the
                mapping or choose another file.
              </p>
            )}
            <div className="form-actions crm-review-actions">
              <button disabled={busy} onClick={() => setPreview(null)}>
                Back to mapping
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  !(preview.summary?.created || preview.summary?.updated)
                }
                onClick={() => void commit()}
              >
                {busy
                  ? "Importing…"
                  : `Import ${Number(preview.summary?.created ?? 0) + Number(preview.summary?.updated ?? 0)} contact${Number(preview.summary?.created ?? 0) + Number(preview.summary?.updated ?? 0) === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
