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
  Columns3,
  SlidersHorizontal,
} from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import "./crm.css";
import { StudentContacts } from "./student-contacts";
import { contactDisplayName, navigateTutor, readContactLocation } from "../lib/tutor-workspace";
import { DuplicateReview } from "./duplicate-review";
import { hasPermission } from "@palladium/contracts";
import {
  builtinColumns,
  defaultColumns,
  columnCell,
  CustomFieldInputs,
  customFieldValues,
  ColumnsDialog,
  FiltersDialog,
  type CRMField,
  type CRMFilter,
} from "./crm-controls";
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
  emailOptIn: "Email updates permitted",
  whatsappOptIn: "WhatsApp updates permitted",
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
  review: "need a decision",
};
const actionLabels: Record<string, string> = {
  create: "Add",
  update: "Update",
  skip: "Skip",
  error: "Fix row",
  review: "Review match",
};
export function CRM({
  api,
  onConnect,
  businessId,
  role,
  permissions,
  onMessage,
  onOpenTracker,
}: {
  api: Api;
  onConnect: () => void;
  onOpenTracker?: (studentId: string) => void;
  businessId?: string;
  role?: string;
  permissions?: string[];
  onMessage?: (audience: {
    clientIds?: string[];
    filter?: Record<string, unknown>;
  }) => void;
}) {
  const canRead = hasPermission({ role: role ?? "", permissions }, "clients.read");
  const canWrite = hasPermission({ role: role ?? "", permissions }, "clients.write");
  const canMerge = hasPermission({ role: role ?? "", permissions }, "clients.merge");
  const [detailTab, setDetailTab] = useState("record"), [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [recordDirty, setRecordDirty] = useState(false);
  const [fields, setFields] = useState<CRMField[]>([]),
    [fieldError, setFieldError] = useState("");
  const [columnsOpen, setColumnsOpen] = useState(false),
    [filtersOpen, setFiltersOpen] = useState(false);
  const [visible, setVisible] = useState<string[]>(defaultColumns),
    [preferencesBusiness, setPreferencesBusiness] = useState<string | null>(
      null,
    );
  const [kind, setKind] = useState(""),
    [tag, setTag] = useState(""),
    [source, setSource] = useState(""),
    [hasEmail, setHasEmail] = useState(""),
    [hasPhone, setHasPhone] = useState("");
  const [filters, setFilters] = useState<CRMFilter[]>([]),
    [sortBy, setSortBy] = useState("displayName"),
    [sortDirection, setSortDirection] = useState("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [allMatching, setAllMatching] = useState(false);
  const [selectionKey, setSelectionKey] = useState("");
  const currentBusiness = businessId ?? "default";
  const columns = [
    ...builtinColumns,
    ...fields.map((field) => ({
      key: `custom:${field.id}`,
      label: field.label,
      sort: `custom:${field.id}`,
    })),
  ];
  const displayedColumns = visible
    .map((key) => columns.find((c) => c.key === key))
    .filter((c): c is (typeof columns)[number] => !!c);
  useEffect(() => {
    let cancelled = false;
    setFields([]);
    setFieldError("");
    if (!canRead) return;
    api("clients/v1/fields")
      .then((data) => {
        if (!cancelled) setFields(data.items ?? []);
      })
      .catch((e) => {
        if (!cancelled) setFieldError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, canRead]);
  useEffect(() => {
    let keys = defaultColumns;
    try {
      const saved = JSON.parse(
        localStorage.getItem(`tuts.crm.columns.${currentBusiness}`) ?? "null",
      );
      if (
        Array.isArray(saved) &&
        saved.length &&
        saved.every((k) => typeof k === "string")
      )
        keys = [...new Set(saved)];
    } catch {}
    setVisible(keys);
    setPreferencesBusiness(currentBusiness);
  }, [currentBusiness]);
  useEffect(() => {
    if (preferencesBusiness === currentBusiness)
      try {
        localStorage.setItem(
          `tuts.crm.columns.${currentBusiness}`,
          JSON.stringify(visible),
        );
      } catch {}
  }, [visible, preferencesBusiness, currentBusiness]);
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
  function openEditor(row: Row) {
    setError(""); setEditor(row); setDetailTab("record"); setRecordDirty(false);
    if (businessId) navigateTutor(businessId, "clients", {contact:row.id ?? null});
  }
  function closeEditor() {
    setEditor(null); setError(""); setRecordDirty(false);
    if (businessId) navigateTutor(businessId, "clients", {contact:null});
  }
  useEffect(() => {
    if (!businessId || !canRead) return;
    let generation = 0, cancelled = false;
    function restore() {
      const id = readContactLocation(new URLSearchParams(window.location.search), businessId!);
      const request = ++generation;
      setEditor(null); setRecordDirty(false); setDetailTab("record");
      if (id) api(`clients/v1/clients/${id}`).then(data => {
        if (!cancelled && request === generation) setEditor(data.item);
      }).catch(e => { if (!cancelled && request === generation) setError(errorMessage(e)); });
    }
    restore(); window.addEventListener("popstate", restore);
    return () => { cancelled = true; window.removeEventListener("popstate", restore); };
  }, [api, businessId, canRead]);
  const audienceFilter = {
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(tag ? { tag } : {}),
    ...(source ? { source } : {}),
    ...(hasEmail ? { hasEmail } : {}),
    ...(hasPhone ? { hasPhone } : {}),
    ...(filters.length ? { filters } : {}),
  };
  const filterKey = JSON.stringify(audienceFilter);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    setSelectionKey(filterKey);
    setOffset(0);
  }, [filterKey, currentBusiness]);
  const selectedCount =
    selectionKey === filterKey ? (allMatching ? total : selected.size) : 0;
  function toggleRow(id: string, checked: boolean) {
    setAllMatching(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function togglePage(checked: boolean) {
    setAllMatching(false);
    setSelected((previous) => {
      const next = new Set(previous);
      rows.forEach((row) => {
        if (checked) next.add(row.id);
        else next.delete(row.id);
      });
      return next;
    });
  }
  function sort(key: string) {
    setSortBy(key);
    setSortDirection(
      sortBy === key && sortDirection === "asc" ? "desc" : "asc",
    );
    setOffset(0);
  }

  useEffect(() => {
    let cancelled = false;
    if (!canRead) { setRows([]); setTotal(0); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(
      () => {
        api(
          `clients/v1/clients?${new URLSearchParams({ limit: "50", offset: String(offset), sortBy, sortDirection, ...Object.fromEntries(Object.entries(audienceFilter).map(([key, value]) => [key, key === "filters" ? JSON.stringify(value) : String(value)])) })}`,
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
  }, [api, canRead, filterKey, sortBy, sortDirection, offset, revision]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canWrite) return;
    const f = new FormData(e.currentTarget);
    const firstName = String(f.get("firstName")).trim(),
      lastName = String(f.get("lastName")).trim();
    const displayName = contactDisplayName(editor?.id ? editor : null, firstName, lastName, String(f.get("displayName") ?? ""));
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
          ...(!fieldError
            ? {
                customFields: {
                  ...editor?.customFields,
                  ...customFieldValues(f, fields),
                },
              }
            : {}),
          emailOptIn: f.get("emailOptIn") === "on",
          whatsappOptIn: f.get("whatsappOptIn") === "on",
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
      closeEditor();
      setRevision((n) => n + 1);
      setMessage("Contact saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const filtered = Boolean(
    search ||
      status ||
      kind ||
      tag ||
      source ||
      hasEmail ||
      hasPhone ||
      filters.length,
  );
  function clearFilters() {
    setSearch("");
    setStatus("");
    setKind("");
    setTag("");
    setSource("");
    setHasEmail("");
    setHasPhone("");
    setFilters([]);
    setOffset(0);
  }
  function addContact() {
    if (!canWrite) return;
    setError("");
    setMessage("");
    setEditor({});
    setDetailTab("record");
    setRecordDirty(false);
  }
  if (!canRead) return <Empty>You do not have access to this business's CRM.</Empty>;
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
          <button onClick={() => setDuplicatesOpen(true)}>Review duplicates</button>
          {canWrite && <button onClick={() => setImporting(true)}>
            <Upload size={16} />
            Import contacts
          </button>}
          {canWrite && <button className="primary" onClick={addContact}>
            <Plus size={16} />
            Add contact
          </button>}
        </div>
      </div>
      <Notice error={!editor ? error || fieldError : ""} message={message} />
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
          <select
            aria-label="Filter contacts by relationship"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All relationships</option>
            <option value="student">Students</option>
            <option value="payer">Parents / payers</option>
          </select>
          <button onClick={() => setFiltersOpen(true)}>
            <SlidersHorizontal size={16} />
            Filters{filters.length ? ` (${filters.length})` : ""}
          </button>
          <button onClick={() => setColumnsOpen(true)}>
            <Columns3 size={16} />
            Columns
          </button>
          {filtered && <button onClick={clearFilters}>Clear filters</button>}
          <span className="tag" aria-live="polite">
            {loading
              ? "Searching…"
              : `${total} ${filtered ? "matching " : ""}contact${total === 1 ? "" : "s"}`}
          </span>
        </div>
        <details className="crm-extra-filters">
          <summary>More contact filters</summary>
          <div className="crm-filter-inline">
            <label>
              Tag
              <input
                maxLength={80}
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="Exact tag"
              />
            </label>
            <label>
              Source
              <input
                maxLength={160}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Exact source"
              />
            </label>
            <label>
              Email
              <select
                value={hasEmail}
                onChange={(e) => setHasEmail(e.target.value)}
              >
                <option value="">Any</option>
                <option value="true">Has email</option>
                <option value="false">No email</option>
              </select>
            </label>
            <label>
              Phone
              <select
                value={hasPhone}
                onChange={(e) => setHasPhone(e.target.value)}
              >
                <option value="">Any</option>
                <option value="true">Has phone</option>
                <option value="false">No phone</option>
              </select>
            </label>
          </div>
        </details>
        {selectedCount > 0 && (
          <div className="crm-selection" role="status">
            <strong>
              {selectedCount} contact{selectedCount === 1 ? "" : "s"} selected
              {allMatching ? " across all matching pages" : ""}
            </strong>
            {!allMatching && total > 0 && (
              <button
                disabled={loading}
                onClick={() => {
                  setAllMatching(true);
                  setSelected(new Set());
                }}
              >
                Select all {total} matching contacts
              </button>
            )}
            <button
              onClick={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
            >
              Clear selection
            </button>
            <button
              className="primary"
              disabled={loading || !onMessage}
              onClick={() =>
                onMessage?.(
                  allMatching
                    ? { filter: audienceFilter }
                    : { clientIds: [...selected] },
                )
              }
            >
              Message selected
            </button>
          </div>
        )}
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
                  {canWrite && <button className="primary" onClick={addContact}>
                    <Plus size={16} /> Add contact
                  </button>}
                  {canWrite && <button onClick={() => setImporting(true)}>
                    <Upload size={16} /> Import spreadsheet
                  </button>}
                </>
              )}
            </div>
          </Empty>
        ) : (
          <div className="table-scroll">
            <label className="crm-check crm-mobile-page-selection">
              <input
                type="checkbox"
                checked={
                  allMatching || rows.every((row) => selected.has(row.id))
                }
                onChange={(e) => togglePage(e.target.checked)}
              />
              Select contacts on this page
            </label>
            <table className="crm-contacts-table">
              <thead>
                <tr>
                  <th className="crm-selection-cell">
                    <input
                      type="checkbox"
                      aria-label="Select contacts on this page"
                      checked={
                        allMatching || rows.every((row) => selected.has(row.id))
                      }
                      onChange={(e) => togglePage(e.target.checked)}
                    />
                  </th>
                  {displayedColumns.map((column) => (
                    <th
                      key={column.key}
                      aria-sort={
                        column.sort === sortBy
                          ? sortDirection === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {column.sort ? (
                        <button
                          className="crm-sort"
                          onClick={() => sort(column.sort!)}
                        >
                          {column.label}
                          {column.sort === sortBy
                            ? sortDirection === "asc"
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="crm-selection-cell">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.displayName}`}
                        checked={allMatching || selected.has(row.id)}
                        disabled={allMatching}
                        onChange={(e) => toggleRow(row.id, e.target.checked)}
                      />
                    </td>
                    {displayedColumns.map((column) => (
                      <td key={column.key} data-label={column.label}>
                        {column.key === "displayName" ? <button className="crm-record-open" onClick={() => openEditor(row)} aria-label={`Open ${row.displayName}`}>{columnCell(row, column, fields)}</button> : columnCell(row, column, fields)}
                      </td>
                    ))}
                    <td className="crm-edit-cell">
                      <button
                        aria-label={`Edit ${row.displayName}`}
                        onClick={() => {
                          openEditor(row);
                        }}
                      >
                        <Pencil size={15} />
                        {canWrite ? "Edit" : "View"}
                      </button>
                      {row.kind === "student" && onOpenTracker && <button onClick={() => onOpenTracker(row.id)} aria-label={`Track ${row.displayName}`}>Tracker ↗</button>}
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
          {total > 50 && <button
            disabled={loading || !offset}
            onClick={() => setOffset((n) => Math.max(0, n - 50))}
          >
            Previous
          </button>}
          {total > 50 && <button
            disabled={loading || offset + 50 >= total}
            onClick={() => setOffset((n) => n + 50)}
          >
            Next
          </button>}
        </div>
      </section>
      {editor && (
        <Modal
          title={editor.id ? editor.displayName : "Add contact"}
          onClose={() => {
            if (!busy) closeEditor();
          }}
        >
          <Notice error={error} />
          {editor.id && editor.kind === "student" && onOpenTracker && <div className="tracker-actions"><button disabled={busy || recordDirty} onClick={() => onOpenTracker(editor.id)}>Open student tracker ↗</button></div>}
          {editor.id && editor.kind === "student" && <div className="student-detail-tabs" role="tablist" aria-label="Student details"><button role="tab" disabled={busy} aria-selected={detailTab === "record"} onClick={() => setDetailTab("record")}>Record details</button><button role="tab" disabled={busy || recordDirty} aria-selected={detailTab === "contacts"} onClick={() => setDetailTab("contacts")}>Related contacts</button></div>}
          {recordDirty && editor.kind === "student" && <p className="crm-helper">Save your record changes before editing related contacts.</p>}
          {editor.id && editor.kind === "student" && <div hidden={detailTab !== "contacts"}><StudentContacts api={api} student={editor} canWrite={canWrite} onBusyChange={setBusy} onChanged={async () => { const data = await api(`clients/v1/clients/${editor.id}`); setEditor(data.item); setRevision((n) => n + 1); }} /></div>}
          <div hidden={detailTab !== "record"}>
          <p className="crm-helper">
            Provide at least one name. Display names follow first and last name unless you set a custom name. Email and other details are optional.
          </p>
          <form key={`${editor.id ?? "new"}:${editor.revision ?? 0}`} onSubmit={save} onChange={() => setRecordDirty(true)}>
            <fieldset disabled={!canWrite || busy} className="crm-record-fields">
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
              <CustomFieldInputs
                fields={fields}
                values={editor.customFields ?? {}}
              />
            </div>
            <div className="crm-permissions">
              <label className="crm-check">
                <input
                  type="checkbox"
                  name="emailOptIn"
                  defaultChecked={editor.emailOptIn === true}
                />
                Email updates permitted
              </label>
              <label className="crm-check">
                <input
                  type="checkbox"
                  name="whatsappOptIn"
                  defaultChecked={editor.whatsappOptIn === true}
                />
                WhatsApp updates permitted
              </label>
              <p className="crm-helper">
                Record permission given by this contact before sending updates.
              </p>
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
            </fieldset>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  closeEditor();
                }}
              >
                Cancel
              </button>
              {canWrite && <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save contact"}
              </button>}
            </div>
          </form>
          </div>
        </Modal>
      )}
      {columnsOpen && (
        <ColumnsDialog
          api={api}
          columns={columns}
          visible={visible}
          fields={fields}
          canManage={canWrite && (role === "owner" || role === "admin")}
          onChange={setVisible}
          onField={(field) => {
            setFields((previous) => [
              ...previous.filter((f) => f.id !== field.id),
              field,
            ]);
            if (!visible.includes(`custom:${field.id}`))
              setVisible((previous) => [...previous, `custom:${field.id}`]);
            setFieldError("");
          }}
          onClose={() => setColumnsOpen(false)}
        />
      )}
      {filtersOpen && (
        <FiltersDialog
          fields={fields}
          filters={filters}
          onApply={setFilters}
          onClose={() => setFiltersOpen(false)}
        />
      )}
      {duplicatesOpen && <DuplicateReview api={api} canWrite={canWrite} canMerge={canMerge} fieldLabels={Object.fromEntries(fields.map((field) => [`custom:${field.id}`, field.label]))} onClose={() => setDuplicatesOpen(false)} onChanged={() => { setRevision((n) => n + 1); setSelected(new Set()); setAllMatching(false); }} />}
      {importing && canWrite && (
        <ImportContacts
          api={api}
          fields={fields}
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
  fields,
  onClose,
  onImported,
}: {
  api: Api;
  onClose: () => void;
  onImported: (message: string) => void;
  fields: CRMField[];
}) {
  const content = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState<Row | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [decisions, setDecisions] = useState<Record<number, { action: "create" | "update" | "skip"; clientId?: string }>>({}),
    [previewDirty, setPreviewDirty] = useState(false),
    [previewOffset, setPreviewOffset] = useState(0),
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
    duplicateMode: "skip",
    decisions: Object.entries(decisions).map(([rowNumber, decision]) => ({ rowNumber: Number(rowNumber), ...decision })),
  });
  async function parse(file: File) {
    setBusy(true);
    setError("");
    setPreview(null);
    setSheet(null);
    setDecisions({});
    setPreviewDirty(false);
    setPreviewOffset(0);
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
      for (const field of fields)
        initial[`custom:${field.id}`] =
          data.item.headers.find(
            (h: string) =>
              h.trim().toLowerCase() === field.label.trim().toLowerCase(),
          ) ?? "";
      setMapping(initial);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    if (!mapping.displayName && !mapping.firstName && !mapping.lastName) {
      setError(
        "Map a display name, first name or last name column before previewing.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await api("clients/v1/imports/preview", "POST", payload());
      setPreview(data.item);
      setPreviewDirty(false);
      setKey(crypto.randomUUID());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (previewDirty || preview?.summary?.review) return;
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
            review the result, then import. Matching names and emails require an
            explicit decision. Shared family emails are allowed.
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
                  {Object.entries({
                    ...importFields,
                    ...Object.fromEntries(
                      fields.map((f) => [`custom:${f.id}`, f.label]),
                    ),
                  }).map(([field, label]) => (
                    <label key={field}>
                      {label}
                      <select
                        aria-label={label}
                        disabled={busy}
                        value={mapping[field] ?? ""}
                        onChange={(e) => {
                          setMapping({ ...mapping, [field]: e.target.value });
                          setPreview(null);
                          setDecisions({});
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
                <p className="crm-helper">Email is optional. When a row could match an existing record, choose to create a separate record, update a specific record or skip the row.</p>
                <p className="crm-helper">
                  Stage accepts lead, active or inactive. Relationship accepts
                  student or payer. Unmapped values use the contact defaults.
                </p>
                {!preview && (
                  <div className="form-actions">
                    <button
                      className="primary"
                      disabled={busy || !(mapping.displayName || mapping.firstName || mapping.lastName)}
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
              Choose a decision for every possible match. Updates replace mapped non-empty values in the selected record. Skipped rows and rows with errors will not be imported.
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
                  {preview.rows?.slice(previewOffset, previewOffset + 100).map((row: Row) => (
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
                        {row.candidates?.length > 0 && <div className="crm-import-decision"><ul className="duplicate-reasons">{row.candidates.map((candidate: Row) => <li key={candidate.id}><strong>{candidate.displayName}</strong>{candidate.email ? ` · ${candidate.email}` : ""} · {(candidate.reasons ?? []).join(", ")}</li>)}</ul><label>Decision for row {row.rowNumber}<select disabled={busy} value={decisions[row.rowNumber]?.action === "update" ? `update:${decisions[row.rowNumber].clientId}` : decisions[row.rowNumber]?.action ?? ""} onChange={(e) => { const value = e.target.value; setDecisions((current) => { const next = { ...current }; if (!value) delete next[row.rowNumber]; else next[row.rowNumber] = value.startsWith("update:") ? { action: "update", clientId: value.slice(7) } : { action: value as "create" | "skip" }; return next; }); setPreviewDirty(true); }}><option value="">Choose a decision…</option><option value="create">Create separate record</option>{row.candidates.map((candidate: Row) => <option value={`update:${candidate.id}`} key={candidate.id}>Update {candidate.displayName} · …{String(candidate.id).slice(-8)}</option>)}<option value="skip">Skip this row</option></select></label></div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows?.length > 100 && (
              <p className="small-note">
                Showing rows {previewOffset + 1}–{Math.min(previewOffset + 100, preview.rows.length)} of {preview.rows.length}. Review every page before importing.
              </p>
            )}
            {preview.rows?.length > 100 && <div className="pagination"><button disabled={busy || previewOffset === 0} onClick={() => setPreviewOffset((n) => Math.max(0, n - 100))}>Previous rows</button><button disabled={busy || previewOffset + 100 >= preview.rows.length} onClick={() => setPreviewOffset((n) => n + 100)}>Next rows</button></div>}
            {previewDirty && <p role="status" className="student-contact-warning">Decisions changed. Refresh the preview to check the result before importing.</p>}
            {preview.summary?.review > 0 && <p className="crm-helper">{preview.summary.review} rows still need a decision. All possible matches must be resolved before import.</p>}
            {!(preview.summary?.created || preview.summary?.updated || preview.summary?.review || previewDirty) && (
              <p className="crm-helper">
                There are no contacts to add or update. Go back to change the
                mapping or choose another file.
              </p>
            )}
            <div className="form-actions crm-review-actions">
              <button disabled={busy} onClick={() => setPreview(null)}>
                Back to mapping
              </button>
              <button disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Refresh preview"}</button>
              <button
                className="primary"
                disabled={
                  busy ||
                  previewDirty ||
                  preview.summary?.review > 0 ||
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
