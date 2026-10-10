import { useEffect, useRef, useState } from "react";
import { canReadFinancial, hasPermission } from "@palladium/contracts";
import { Download, Upload, Plus, RefreshCw } from "lucide-react";
import { Empty, Modal, Notice } from "../components/shared";
import {
  downloadFile,
  errorMessage,
  money,
  type Api,
  type Business,
  type Row,
} from "../lib/api";
import { useListOffset, useListQuery } from "../lib/use-list-query";
import { currencyScale, decimalMinor } from "../lib/history-money";
import "./work-history.css";

const currentMonth = (business: Business) => {
  const timeZone =
    business.settings?.profile?.timeZone ||
    business.settings?.timeZone ||
    business.settings?.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
};
const statuses = ["unsent", "pending", "paid"];
const statusName = (s: string) =>
  ({ unsent: "Unsent", pending: "Pending", paid: "Paid" })[s] || s;
export function WorkHistory({
  api,
  business,
  mode = "work",
  initialFile,
  onFileConsumed,
}: {
  api: Api;
  business: Business;
  mode?: "work" | "invoices";
  initialFile?: File | null;
  onFileConsumed?: () => void;
}) {
  const [view, setView] = useState<"aggregate" | "month" | "sources">(
      mode === "invoices" ? "month" : "aggregate",
    ),
    [month, setMonth] = useState(() => currentMonth(business)),
    [allMonths, setAllMonths] = useState(false),
    [status, setStatus] = useState(""),
    [search, setSearch] = useState(""),
    [revision, setRevision] = useState(0),
    [importing, setImporting] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Row | null>(null),
    [manual, setManual] = useState(false),
    [summary, setSummary] = useState<Row | null>(null),
    [summaryLoading, setSummaryLoading] = useState(false);
  const canRead =
      canReadFinancial(business) && business.entitlements.includes("billing"),
    canWrite = canRead && hasPermission(business, "billing.write");
  const filterKey = JSON.stringify({
      view,
      month,
      allMonths,
      status,
      search,
      mode,
    }),
    [offset, setOffset] = useListOffset(filterKey);
  const params = new URLSearchParams({ limit: "50", offset: String(offset) });
  if (view !== "sources") {
    if (!allMonths) params.set("month", month);
    if (status) params.set("status", status);
    if (search) params.set("search", search);
  }
  const resource =
    view === "sources"
      ? "history-imports"
      : mode === "invoices"
        ? "invoice-history"
        : "work-log";
  const list = useListQuery(api, `billing/v1/${resource}?${params}`, {
    enabled: canRead && view !== "aggregate",
    revision,
    scope: business.id,
    delay: search ? 250 : 0,
  });
  const rows: Row[] = list.data?.items || [],
    total = list.data?.total || 0;
  useEffect(() => {
    if (initialFile && canWrite) setImporting(true);
  }, [initialFile, canWrite]);
  useEffect(() => {
    let cancelled = false;
    if (!canRead || view !== "aggregate") return;
    setSummaryLoading(true);
    api("billing/v1/work-log/summary", "GET", undefined, undefined, {
      fresh: revision > 0,
    })
      .then((data) => {
        if (!cancelled) {
          setSummary(data.item);
          setError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, canRead, view, revision]);
  async function change(row: Row, patch: Row) {
    setBusy(true);
    setError("");
    try {
      await api(
        `billing/v1/${mode === "invoices" ? "invoice-history" : "work-log"}/${row.id}`,
        "PATCH",
        patch,
      );
      setEditing(null);
      setRevision((n) => n + 1);
      setNotice(
        "Record updated. Historical paid records are declarations, not new charges.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function original(row: Row) {
    try {
      await downloadFile(
        `billing/v1/history-imports/${row.id}/download`,
        business.id,
        row.fileName || row.file_name || "original-source",
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  if (!canRead)
    return <Empty>You do not have access to business financial history.</Empty>;
  return (
    <section className="work-history">
      <div className="panel-title">
        <div>
          <h2>{mode === "work" ? "Work and hours" : "Invoice history"}</h2>
          <p className="muted">
            {mode === "work"
              ? "Track recorded hours, services and their billing status."
              : "All issued and imported invoices, with historical payment declarations clearly marked."}
          </p>
        </div>
        <div className="work-actions">
          <button
            aria-label="Refresh history"
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={16} />
          </button>
          {canWrite && (
            <button onClick={() => setImporting(true)}>
              <Upload size={16} />
              Import {mode === "work" ? "workbook" : "history"}
            </button>
          )}
          {mode === "invoices" && canWrite && (
            <button onClick={() => setManual(true)}>
              <Plus size={16} />
              Add past invoice
            </button>
          )}
        </div>
      </div>
      <Notice error={error || list.error} message={notice} />
      <div className="work-tabs" role="tablist" aria-label="History views">
        {mode === "work" && (
          <button
            role="tab"
            aria-selected={view === "aggregate"}
            onClick={() => setView("aggregate")}
          >
            All-time student totals
          </button>
        )}
        <button
          role="tab"
          aria-selected={view === "month"}
          onClick={() => setView("month")}
        >
          {mode === "work" ? "Monthly work" : "Invoices"}
        </button>
        <button
          role="tab"
          aria-selected={view === "sources"}
          onClick={() => setView("sources")}
        >
          Original files
        </button>
      </div>
      {view === "aggregate" ? (
        <>
          <p className="work-help">
            Totals include recorded work only. These amounts are separate from
            issued invoices and verified payments.
          </p>
          {summaryLoading && (
            <p role="status">
              {summary ? "Updating totals…" : "Loading totals…"}
            </p>
          )}
          <div className="work-total-grid">
            {(summary?.currencies || []).map((c: Row) => (
              <article key={c.currency}>
                <span>{c.currency} work recorded</span>
                <strong>{Number(c.totalHours).toLocaleString()} hours</strong>
                <span>{money(c.totalMinor, c.currency)}</span>
                <small>
                  Unsent {money(c.unsentMinor, c.currency)} · Pending{" "}
                  {money(c.pendingMinor, c.currency)} · Paid{" "}
                  {money(c.paidMinor, c.currency)}
                </small>
              </article>
            ))}
          </div>
          <div className="work-table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    "Student",
                    "Total hours",
                    "Total value",
                    "Unsent",
                    "Pending",
                    "Paid",
                    "Last work",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(summary?.students || []).map((r: Row, i: number) => (
                  <tr key={`${r.studentName}:${r.currency}:${i}`}>
                    <td>{r.studentName}</td>
                    <td>{Number(r.totalHours).toLocaleString()}</td>
                    <td>{money(r.totalMinor, r.currency)}</td>
                    <td>{money(r.unsentMinor, r.currency)}</td>
                    <td>{money(r.pendingMinor, r.currency)}</td>
                    <td>{money(r.paidMinor, r.currency)}</td>
                    <td>{r.lastDate?.slice(0, 10) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!summaryLoading && !summary?.students?.length && (
            <Empty>Import a time tracker to see student totals.</Empty>
          )}
        </>
      ) : (
        <>
          {view !== "sources" && (
            <div className="work-filters">
              <label>
                {allMonths
                  ? "Month (all history selected)"
                  : mode === "invoices"
                    ? "Invoice / service month"
                    : "Work month"}
                <input
                  type="month"
                  value={month}
                  disabled={allMonths}
                  onChange={(e) => {
                    if (e.target.value) setMonth(e.target.value);
                  }}
                />
              </label>
              <label className="work-checkbox">
                <input
                  type="checkbox"
                  checked={allMonths}
                  onChange={(e) => setAllMonths(e.target.checked)}
                />
                All months
              </label>
              <label>
                Status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  <option value="unpaid">Unpaid (unsent + pending)</option>
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {statusName(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Search
                <input
                  placeholder="Student, service or invoice"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  maxLength={160}
                />
              </label>
            </div>
          )}
          {list.loading && (
            <p role="status">
              {rows.length ? "Updating results…" : "Loading history…"}
            </p>
          )}
          <div className="work-table-wrap" aria-busy={list.loading}>
            <table>
              <thead>
                <tr>
                  {(view === "sources"
                    ? ["Original file", "Kind", "Imported", "Status", ""]
                    : mode === "invoices"
                      ? [
                          "Invoice",
                          "Student / payer",
                          "Invoice / service month",
                          "Total",
                          "Paid amount",
                          "Status",
                          "Source",
                          "",
                        ]
                      : [
                          "Date",
                          "Student",
                          "Service",
                          "Hours",
                          "Hourly rate",
                          "Total",
                          "Invoice status",
                          "Notes",
                          "",
                        ]
                  ).map((h, i) => (
                    <th key={`${h}:${i}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.origin || ""}:${row.id}`}>
                    {view === "sources" ? (
                      <>
                        <td>{row.fileName || row.file_name}</td>
                        <td>{row.kind}</td>
                        <td>
                          {(row.createdAt || row.created_at || "").slice(0, 10)}
                        </td>
                        <td>
                          {row.committedAt ? "Imported" : "Awaiting review"}
                        </td>
                        <td>
                          <button onClick={() => void original(row)}>
                            <Download size={15} />
                            Download original
                          </button>
                        </td>
                      </>
                    ) : mode === "invoices" ? (
                      <>
                        <td>{row.invoiceNumber || row.id.slice(0, 8)}</td>
                        <td>{row.studentName || row.payerName}</td>
                        <td>
                          {row.serviceMonth || row.date?.slice(0, 7) || "—"}
                        </td>
                        <td>
                          {money(
                            row.amountMinor ?? row.totalMinor,
                            row.currency,
                          )}
                        </td>
                        <td>
                          {row.paidMinor != null
                            ? money(row.paidMinor, row.currency)
                            : row.origin !== "native" && row.status === "paid"
                              ? money(row.amountMinor, row.currency)
                              : "—"}
                        </td>
                        <td>
                          <span className={`work-status ${row.status}`}>
                            {statusName(row.status)}
                          </span>
                        </td>
                        <td>
                          {row.origin === "native"
                            ? row.paymentEvidence === "simulated"
                              ? "Tuts invoice · simulated payment"
                              : "Tuts invoice"
                            : "Historical declaration"}
                        </td>
                        <td>
                          {canWrite && row.origin !== "native" && (
                            <button
                              disabled={busy || list.loading}
                              onClick={() => setEditing(row)}
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{row.date?.slice(0, 10)}</td>
                        <td>{row.studentName}</td>
                        <td>{row.serviceType || "—"}</td>
                        <td>{row.hours}</td>
                        <td>{money(row.rateMinor, row.currency)}</td>
                        <td>{money(row.amountMinor, row.currency)}</td>
                        <td>
                          <span className={`work-status ${row.status}`}>
                            {statusName(row.status)}
                          </span>
                        </td>
                        <td className="work-notes">{row.notes || "—"}</td>
                        <td>
                          {canWrite && (
                            <button
                              disabled={busy || list.loading}
                              onClick={() => setEditing(row)}
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.loading && !rows.length && (
            <Empty>
              {view === "sources"
                ? "Uploaded source files will appear here."
                : "No records match these filters."}
            </Empty>
          )}
          <div className="pagination">
            <span>
              {total
                ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}`
                : "0 records"}
            </span>
            {total > 50 && (
              <>
                <button
                  disabled={list.loading || !offset}
                  onClick={() => setOffset((n) => Math.max(0, n - 50))}
                >
                  Previous
                </button>
                <button
                  disabled={list.loading || offset + 50 >= total}
                  onClick={() => setOffset((n) => n + 50)}
                >
                  Next
                </button>
              </>
            )}
          </div>
        </>
      )}
      {importing && (
        <HistoryImport
          api={api}
          defaultKind={mode === "work" ? "auto" : "invoices"}
          initialFile={initialFile}
          onClose={() => {
            setImporting(false);
            onFileConsumed?.();
          }}
          onImported={(message) => {
            setImporting(false);
            onFileConsumed?.();
            setRevision((n) => n + 1);
            setNotice(message);
          }}
        />
      )}
      {editing && (
        <Modal
          title={
            mode === "work" ? "Edit recorded work" : "Edit historical invoice"
          }
          onClose={() => !busy && setEditing(null)}
        >
          <Notice error={error} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const f = new FormData(e.currentTarget),
                  patch: Row = {
                    status: String(f.get("status")),
                    revision: editing.revision,
                  };
                if (mode === "work") patch.notes = String(f.get("notes") || "");
                if (mode === "work")
                  Object.assign(patch, {
                    studentName: String(f.get("studentName")),
                    serviceType: String(f.get("serviceType")),
                    date: String(f.get("date")),
                    hours: Number(f.get("hours")),
                    rateMinor: decimalMinor(
                      String(f.get("rate")),
                      editing.currency,
                    ),
                    countAsClasses: f.get("countAsClass") === "on",
                  });
                void change(editing, patch);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            <fieldset disabled={busy}>
              {mode === "work" && (
                <>
                  <div className="form-grid">
                    <label>
                      Student
                      <input
                        name="studentName"
                        required
                        defaultValue={editing.studentName}
                      />
                    </label>
                    <label>
                      Service
                      <input
                        name="serviceType"
                        defaultValue={editing.serviceType || ""}
                      />
                    </label>
                    <label>
                      Date
                      <input
                        name="date"
                        type="date"
                        required
                        defaultValue={editing.date?.slice(0, 10)}
                      />
                    </label>
                    <label>
                      Hours
                      <input
                        name="hours"
                        type="number"
                        min="0.000001"
                        step="0.000001"
                        required
                        defaultValue={editing.hours}
                      />
                    </label>
                    <label>
                      Hourly rate ({editing.currency})
                      <input
                        name="rate"
                        inputMode="decimal"
                        required
                        defaultValue={String(
                          editing.rateMinor /
                            currencyScale(editing.currency).scale,
                        )}
                      />
                    </label>
                  </div>
                  <label className="work-checkbox">
                    <input
                      name="countAsClass"
                      type="checkbox"
                      defaultChecked={editing.countAsClasses}
                    />
                    Count this work entry as a class in analytics
                  </label>
                </>
              )}
              <label>
                Invoice status
                <select name="status" defaultValue={editing.status}>
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {statusName(s)}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "work" && (
                <label>
                  Notes
                  <textarea name="notes" defaultValue={editing.notes || ""} />
                </label>
              )}
            </fieldset>
            <p className="work-help">
              Paid means you recorded payment in your history. This does not
              charge a client or verify a provider transaction.
            </p>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save record
              </button>
            </div>
          </form>
        </Modal>
      )}
      {manual && (
        <PastInvoice
          api={api}
          onClose={() => setManual(false)}
          onSaved={() => {
            setManual(false);
            setRevision((n) => n + 1);
            setNotice("Historical invoice saved.");
          }}
        />
      )}
    </section>
  );
}
const mappingFields: Record<string, string> = {
  date: "Work / invoice date",
  studentName: "Student / payer name",
  serviceType: "Service type",
  hours: "Hours worked",
  rateMinor: "Hourly rate",
  amountMinor: "Total amount",
  status: "Invoice status",
  notes: "Notes",
  invoiceNumber: "Invoice number",
  paidDate: "Payment date",
  currency: "Currency",
};
function HistoryImport({
  api,
  defaultKind,
  initialFile,
  onClose,
  onImported,
}: {
  api: Api;
  defaultKind: string;
  initialFile?: File | null;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(initialFile || null),
    [preview, setPreview] = useState<Row | null>(null),
    [options, setOptions] = useState<Row>({
      kind: defaultKind,
      currency: "EUR",
      countAsClasses: false,
    }),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [partial, setPartial] = useState(false),
    [accepted, setAccepted] = useState(false),
    [page, setPage] = useState(0);
  const started = useRef(false);
  async function inspect(next: File, settings: Row = options) {
    setFile(next);
    setPreview(null);
    setDirty(true);
    setBusy(true);
    setError("");
    setAccepted(false);
    setPartial(false);
    setPage(0);
    try {
      const form = new FormData();
      form.set("file", next);
      form.set("options", JSON.stringify(settings));
      const r = await api("billing/v1/history-imports/preview", "POST", form);
      setPreview(r.item);
      setOptions({
        ...settings,
        kind: r.item.kind,
        sheetName: r.item.sheetName,
        mapping: r.item.mapping,
        statusMap: r.item.statusMap,
      });
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initialFile && !started.current) {
      started.current = true;
      void inspect(initialFile);
    }
  }, [initialFile]);
  function option(patch: Row) {
    setOptions((o) => ({ ...o, ...patch }));
    setDirty(true);
    setAccepted(false);
  }
  async function commit() {
    if (!preview?.token || dirty) return;
    setBusy(true);
    setError("");
    try {
      const r = await api(
        "billing/v1/history-imports/commit",
        "POST",
        { token: preview.token, allowPartial: partial },
        `history:${preview.token}`,
      );
      onImported(
        r.item?.alreadyCommitted
          ? "This source was already imported. No duplicate records were added."
          : `Source preserved. ${r.item?.importedCount ?? r.item?.imported ?? preview.summary?.valid ?? 0} records imported.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Import work or invoice history"
      onClose={() => !busy && onClose()}
    >
      <Notice error={error} />
      <p className="work-help">
        The original file and all its columns are retained. Review the sheet,
        mapping and statuses before importing. Summary sheets are kept for
        reference.
      </p>
      <label className="upload-button">
        <Upload size={20} />
        {file ? "Choose another file" : "Choose CSV, Excel or PDF"}
        <input
          type="file"
          accept=".csv,.xlsx,.pdf"
          disabled={busy}
          onChange={(e) => {
            const next = e.target.files?.[0];
            if (next)
              void inspect(next, {
                kind: defaultKind,
                currency: "EUR",
                countAsClasses: false,
              });
            e.target.value = "";
          }}
        />
      </label>
      {file && (
        <p>
          <strong>{file.name}</strong> · up to 5 MB
        </p>
      )}
      {busy && <p role="status">Reading and preserving your source…</p>}
      {preview && (
        <>
          <div className="form-grid">
            <label>
              Import as
              <select
                value={options.kind}
                disabled={busy}
                onChange={(e) => option({ kind: e.target.value, mapping: {} })}
              >
                <option value="work">Work and hours</option>
                <option value="invoices">Past invoices</option>
                <option value="archive">Original file only</option>
              </select>
            </label>
            {preview.sheets?.length > 0 && (
              <label>
                Data sheet
                <select
                  value={options.sheetName || ""}
                  disabled={busy}
                  onChange={(e) =>
                    option({ sheetName: e.target.value, mapping: {} })
                  }
                >
                  {preview.sheets.map((s: Row) => (
                    <option key={s.name} value={s.name}>
                      {s.name} ({s.rowCount} rows)
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Currency
              <select
                value={options.currency}
                disabled={busy}
                onChange={(e) => option({ currency: e.target.value })}
              >
                {["EUR", "GBP", "USD", "MAD", "CAD", "AUD"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          {options.kind !== "archive" && (
            <details open className="work-mapping">
              <summary>Column mapping and status meaning</summary>
              <div className="form-grid">
                {Object.entries(mappingFields)
                  .filter(([key]) =>
                    options.kind === "work"
                      ? !["invoiceNumber", "paidDate"].includes(key)
                      : !["hours", "rateMinor"].includes(key),
                  )
                  .map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <select
                        value={options.mapping?.[key] || ""}
                        disabled={busy}
                        onChange={(e) =>
                          option({
                            mapping: {
                              ...options.mapping,
                              [key]: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="">Not mapped</option>
                        {preview.headers?.map((h: string) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
              </div>
              <div className="form-grid">
                {Object.entries(options.statusMap || {}).map(
                  ([source, target]) => (
                    <label key={source}>
                      “{source || "(blank)"}” means
                      <select
                        value={String(target)}
                        disabled={busy}
                        onChange={(e) =>
                          option({
                            statusMap: {
                              ...options.statusMap,
                              [source]: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="">Needs review</option>
                        {statuses.map((s) => (
                          <option key={s} value={s}>
                            {statusName(s)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ),
                )}
              </div>
              {options.kind === "work" && (
                <label className="work-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(options.countAsClasses)}
                    disabled={busy}
                    onChange={(e) =>
                      option({ countAsClasses: e.target.checked })
                    }
                  />
                  Count imported work rows as classes (only if each row is a
                  class)
                </label>
              )}
            </details>
          )}
          {dirty && (
            <p className="work-warning">
              Mapping changed. Refresh the preview before importing.
            </p>
          )}
          <button
            disabled={busy || !file}
            onClick={() => file && void inspect(file, options)}
          >
            Refresh preview
          </button>
          {preview.warnings?.length > 0 && (
            <ul className="work-warning">
              {preview.warnings.map((w: string, i: number) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <div className="work-preview-summary">
            <strong>{preview.summary?.valid ?? 0} valid</strong>
            <span>{preview.summary?.invalid ?? 0} need attention</span>
            <span>
              {preview.summary?.skipped ?? 0} blank/template rows skipped
            </span>
          </div>
          <div className="work-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source row</th>
                  <th>Date</th>
                  <th>Student</th>
                  <th>Hours / amount</th>
                  <th>Status</th>
                  <th>Review notes</th>
                </tr>
              </thead>
              <tbody>
                {(preview.rows || [])
                  .slice(page * 25, page * 25 + 25)
                  .map((row: Row) => (
                    <tr key={row.rowNumber}>
                      <td>{row.rowNumber}</td>
                      <td>{row.values?.date || "—"}</td>
                      <td>{row.values?.studentName || "—"}</td>
                      <td>
                        {row.values?.hours != null
                          ? `${row.values.hours} h · `
                          : ""}
                        {row.values?.amountMinor != null
                          ? money(
                              row.values.amountMinor,
                              row.values.currency || options.currency,
                            )
                          : "—"}
                      </td>
                      <td>{statusName(row.values?.status || "Unknown")}</td>
                      <td className="work-notes">
                        {[...(row.errors || []), ...(row.warnings || [])].join(
                          " · ",
                        ) || "Ready"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {preview.rows?.length > 25 && (
            <div className="pagination">
              <button disabled={!page} onClick={() => setPage((n) => n - 1)}>
                Previous rows
              </button>
              <span>
                Rows {page * 25 + 1}–
                {Math.min((page + 1) * 25, preview.rows.length)} of{" "}
                {preview.rows.length}
              </span>
              <button
                disabled={(page + 1) * 25 >= preview.rows.length}
                onClick={() => setPage((n) => n + 1)}
              >
                Next rows
              </button>
            </div>
          )}
          {(preview.summary?.invalid || 0) > 0 && (
            <label className="work-checkbox">
              <input
                type="checkbox"
                checked={partial}
                disabled={busy || dirty}
                onChange={(e) => setPartial(e.target.checked)}
              />
              Import valid rows only; keep rejected rows in the preserved source
            </label>
          )}
          <label className="work-checkbox">
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy || dirty}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I reviewed the mapping and historical payment statuses
          </label>
          <div className="form-actions">
            <button disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                dirty ||
                !accepted ||
                ((preview.summary?.invalid || 0) > 0 && !partial)
              }
              onClick={() => void commit()}
            >
              {busy
                ? "Importing…"
                : options.kind === "archive"
                  ? "Preserve original file"
                  : "Import reviewed records"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
function PastInvoice({
  api,
  onClose,
  onSaved,
}: {
  api: Api;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [sources, setSources] = useState<Row[]>([]);
  useEffect(() => {
    let cancelled = false;
    api("billing/v1/history-imports?limit=100&offset=0")
      .then((r) => {
        if (!cancelled) setSources(r.items || []);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  return (
    <Modal title="Add a past invoice" onClose={() => !busy && onClose()}>
      <Notice error={error} />
      <p className="work-help">
        Record a past invoice and attach an original file from your archive.
        Paid is your historical declaration; this creates no charge.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          void (async () => {
            try {
              await api("billing/v1/invoice-history", "POST", {
                studentName: String(f.get("studentName")),
                invoiceNumber: String(f.get("invoiceNumber")),
                date: String(f.get("date")),
                amountMinor: decimalMinor(
                  String(f.get("amount")),
                  String(f.get("currency")),
                ),
                currency: String(f.get("currency")),
                status: String(f.get("status")),
                notes: String(f.get("notes") || ""),
                ...(f.get("paidDate")
                  ? { paidDate: String(f.get("paidDate")) }
                  : {}),
                ...(f.get("importId")
                  ? { importId: String(f.get("importId")) }
                  : {}),
              });
              onSaved();
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <fieldset disabled={busy}>
          <div className="form-grid">
            <label>
              Student / payer
              <input name="studentName" required maxLength={200} />
            </label>
            <label>
              Invoice number
              <input name="invoiceNumber" required maxLength={160} />
            </label>
            <label>
              Invoice date
              <input name="date" type="date" required />
            </label>
            <label>
              Total amount
              <input
                name="amount"
                inputMode="decimal"
                required
                placeholder="120.00"
              />
            </label>
            <label>
              Currency
              <select name="currency" defaultValue="EUR">
                {["EUR", "GBP", "USD", "MAD", "CAD", "AUD"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select name="status" defaultValue="unsent">
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusName(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Payment date (if known)
              <input name="paidDate" type="date" />
            </label>
            <label>
              Original source file
              <select name="importId">
                <option value="">No attachment</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fileName || s.file_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Notes
            <textarea name="notes" maxLength={4000} />
          </label>
        </fieldset>
        <div className="form-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Save historical invoice
          </button>
        </div>
      </form>
    </Modal>
  );
}
