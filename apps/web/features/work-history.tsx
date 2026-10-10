import { useEffect, useState } from "react";
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
import { HistoryImport } from "./history-import";

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
          business={business}
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
