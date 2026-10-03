import { useEffect, useState, type FormEvent } from "react";
import { Download, Pencil, Plus, Search, Upload, Plug } from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
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
    setBusy(true);
    setError("");
    try {
      await api(
        `clients/v1/clients${editor?.id ? `/${editor.id}` : ""}`,
        editor?.id ? "PATCH" : "POST",
        {
          firstName,
          lastName,
          displayName: String(
            f.get("displayName") || `${firstName} ${lastName}`,
          ).trim(),
          ...(!editor?.id ? { kind: f.get("kind") } : {}),
          email: f.get("email") || null,
          phone: f.get("phone") || null,
          status: f.get("status"),
          notes: f.get("notes") || null,
          tags: String(f.get("tags") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          source: f.get("source") || null,
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
  return (
    <>
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
          <button className="primary" onClick={() => setEditor({})}>
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
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
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
          <span className="tag">{total} contacts</span>
        </div>
        {loading ? (
          <Empty>Loading contacts…</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            <h3>
              {search
                ? "No contacts match your search."
                : "Your CRM starts here."}
            </h3>
            <p>
              Add a contact, import a spreadsheet, or connect an existing
              source.
            </p>
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
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
                      {row.source ?? "Added manually"}
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
            {total
              ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}`
              : "No contacts yet"}
          </span>
          <button
            disabled={!offset}
            onClick={() => setOffset((n) => Math.max(0, n - 50))}
          >
            Previous
          </button>
          <button
            disabled={offset + 50 >= total}
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
            if (!busy) setEditor(null);
          }}
        >
          <Notice error={error} />
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
                  defaultValue={editor.email ?? ""}
                />
              </label>
              <label>
                Phone
                <input
                  name="phone"
                  type="tel"
                  defaultValue={editor.phone ?? ""}
                />
              </label>
              <label>
                Relationship
                <select
                  name="kind"
                  defaultValue={editor.kind ?? "student"}
                  disabled={!!editor.id}
                >
                  <option value="student">Student</option>
                  <option value="payer">Parent / payer</option>
                </select>
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
                  defaultValue={editor.source ?? ""}
                  placeholder="Website, referral, …"
                />
              </label>
              <label>
                Tags
                <input
                  name="tags"
                  defaultValue={editor.tags?.join(", ") ?? ""}
                  placeholder="SAT, math, weekly"
                />
              </label>
            </div>
            <label>
              Notes
              <textarea
                name="notes"
                defaultValue={editor.notes ?? ""}
                rows={3}
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditor(null)}
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
            setRevision((n) => n + 1);
            setMessage(summary);
          }}
        />
      )}
    </>
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
  const [sheet, setSheet] = useState<Row | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [mode, setMode] = useState("skip"),
    [preview, setPreview] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState("");
  const payload = () => ({
    rows: sheet?.rows,
    mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
    duplicateMode: mode,
  });
  async function parse(file: File) {
    setBusy(true);
    setError("");
    setPreview(null);
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
      <p className="muted">
        CSV or Excel (.xlsx), up to 5 MB and 2,000 rows. Match your columns,
        review the result, then import. Email identifies duplicates; rows
        without an email are skipped.
      </p>
      <Notice error={error} />
      <div className="toolbar">
        <label className="upload-button">
          <Upload size={16} />
          {sheet ? "Choose another file" : "Choose spreadsheet"}
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
        <button onClick={template}>
          <Download size={16} />
          Example CSV
        </button>
      </div>
      {sheet && (
        <>
          <h3>{sheet.totalRows} rows found</h3>
          <div className="form-grid mapping-grid">
            {Object.entries(importFields).map(([field, label]) => (
              <label key={field}>
                {label}
                <select
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
              </label>
            ))}
          </div>
          <label>
            When an email already exists
            <select
              value={mode}
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
          {!preview && (
            <div className="form-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => void check()}
              >
                {busy ? "Reading…" : "Preview import"}
              </button>
            </div>
          )}
        </>
      )}
      {preview && (
        <>
          <div className="import-summary">
            {Object.entries(preview.summary ?? {}).map(([name, value]) => (
              <span key={name}>
                <strong>{String(value)}</strong> {name}
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
                    <td>{row.action}</td>
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
          <div className="form-actions">
            <button disabled={busy} onClick={() => setPreview(null)}>
              Back to mapping
            </button>
            <button
              className="primary"
              disabled={
                busy || !(preview.summary?.created || preview.summary?.updated)
              }
              onClick={() => void commit()}
            >
              {busy ? "Importing…" : "Import contacts"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
