import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Empty, Modal, Notice } from "../components/shared";
import {
  errorMessage,
  money,
  type Api,
  type Business,
  type Row,
} from "../lib/api";
import "./business-dashboard.css";
import { hasPermission } from '@palladium/contracts';
const previousMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const moveMonth = (month: string, delta: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const labelMonth = (month: string) =>
  new Date(`${month}-02T12:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
const invoiceDay = (month: string) =>
  new Date(`${moveMonth(month, 1)}-01T12:00:00`).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
const shortId = (id: string) => `Student ${id.slice(0, 8)}`;
export function BusinessDashboard({
  api,
  business,
  onInvoices,
}: {
  api: Api;
  business: Business;
  onInvoices: () => void;
}) {
  const [month, setMonth] = useState(previousMonth),
    [settings, setSettings] = useState<Row | null>(null),
    [rates, setRates] = useState<Row[]>([]),
    [students, setStudents] = useState<Row[]>([]),
    [classes, setClasses] = useState<Row[]>([]),
    [report, setReport] = useState<Row | null>(null),
    [finance, setFinance] = useState<Row | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [editor, setEditor] = useState<Row | null>(null),
    [configure, setConfigure] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [studentSearch, setStudentSearch] = useState(""),
    [studentOffset, setStudentOffset] = useState(0),
    [studentTotal, setStudentTotal] = useState(0),
    [studentsLoading, setStudentsLoading] = useState(false),
    [studentsError, setStudentsError] = useState(""),
    [reportMonth, setReportMonth] = useState(""),
    [financeMonth, setFinanceMonth] = useState(""),
    [classesMonth, setClassesMonth] = useState("");
  const manage = hasPermission(business, 'billing.manage'),
    billing = business.entitlements.includes("billing") && hasPermission(business, 'billing.read'),
    scheduling = business.entitlements.includes("scheduling") && hasPermission(business, 'scheduling.read');
  const loadSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const initializedMonth = useRef(false);
  const canReadStudents = business.entitlements.includes("clients") && hasPermission(business, 'clients.read');
  useEffect(() => {
    initializedMonth.current = false;
    setSettings(null); setRates([]); setStudents([]); setClasses([]); setReport(null); setFinance(null);
    setReportMonth(""); setFinanceMonth(""); setClassesMonth(""); setStudentOffset(0); setStudentSearch("");
    setPreview(null); setEditor(null); setConfigure(false);
  }, [api, business.id]);
  useEffect(() => {
    if (!canReadStudents) { setStudents([]); setStudentTotal(0); return; }
    let current = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    setStudentsLoading(true); setStudentsError("");
    const timer = setTimeout(() => {
      timeout = setTimeout(() => controller.abort(), 20_000);
      const query = new URLSearchParams({ kind: "student", limit: "100", offset: String(studentOffset), sortBy: "displayName", sortDirection: "asc" });
      if (studentSearch.trim()) query.set("search", studentSearch.trim());
      void api(`clients/v1/clients?${query}`, "GET", undefined, undefined, { signal: controller.signal }).then(result => {
        if (current) { setStudents(result.items ?? []); setStudentTotal(result.total ?? 0); }
      }).catch(e => { if (current) setStudentsError(controller.signal.aborted ? "Student search timed out. Change the search to try again." : errorMessage(e)); })
        .finally(() => { clearTimeout(timeout); if (current) setStudentsLoading(false); });
    }, studentSearch ? 250 : 0);
    return () => { current = false; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [api, business.id, canReadStudents, studentSearch, studentOffset]);
  async function load(fresh = false) {
    const sequence = ++loadSequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    const request = (path: string) => api(path, "GET", undefined, undefined, { signal: controller.signal, fresh });
    const current = () => sequence === loadSequence.current && !controller.signal.aborted;
    setLoading(true);
    setError("");
    try {
      if (!billing) return;
      const settingsRequest = request("billing/v1/billing-settings").then(s => {
        if (!current()) return null;
        setSettings(s.item);
        if (!initializedMonth.current) {
          initializedMonth.current = true;
          const parts = new Intl.DateTimeFormat("en-CA", { timeZone: s.item.timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
          const initial = moveMonth(`${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`, -1);
          if (initial !== month) setMonth(initial);
        }
        return s.item;
      });
      // Each successful section appears independently; slow contacts or ledger data never gate billing.
      const results = await Promise.allSettled([
        settingsRequest,
        request("billing/v1/student-rates").then(r => { if (current()) setRates(r.items ?? []); }),
        request(`billing/v1/dashboard?month=${month}`).then(d => { if (current()) { setReport(d.item); setReportMonth(month); } }),
        request(`billing/v1/dashboard?month=${moveMonth(month, 1)}`).then(f => { if (current()) { setFinance(f.item); setFinanceMonth(moveMonth(month, 1)); } }),
        settingsRequest.then(async settings => {
          if (!settings || !current()) return;
          if (!scheduling) { setClasses([]); setClassesMonth(month); return; }
          const result = await request(`scheduling/v1/class-ledger?month=${month}&timeZone=${encodeURIComponent(settings.timeZone)}`);
          if (current()) { setClasses(result.items ?? []); setClassesMonth(month); }
        }),
      ]);
      if (sequence === loadSequence.current) {
        const failures = results.filter(result => result.status === "rejected");
        if (failures.length) setError(controller.signal.aborted ? "Some billing data took too long to respond. Refresh to try again." : [...new Set(failures.map(result => errorMessage((result as PromiseRejectedResult).reason)))].join(" "));
      }
    } catch (e) {
      if (sequence === loadSequence.current) setError(errorMessage(e));
    } finally {
      clearTimeout(timer);
      if (sequence === loadSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    setPreview(null);
    return () => {
      loadSequence.current++;
      loadController.current?.abort();
    };
  }, [api, business.id, month, billing, scheduling]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const names = new Map(students.map((s) => [s.id, s.displayName]));
  const tableMonth = reportMonth || classesMonth || month;
  const tableClasses = classesMonth === tableMonth ? classes : [];
  const classCountsKnown = classesMonth === tableMonth;
  const countByClient = new Map<string, Row>();
  for (const c of tableClasses) {
    if (!c.clientId) continue;
    const existing = countByClient.get(c.clientId) || {
      clientId: c.clientId,
      completedCount: 0,
      scheduledCount: 0,
      cancelledCount: 0,
    };
    existing[`${c.status}Count`]++;
    countByClient.set(c.clientId, existing);
  }
  const reportRows = new Map<string, Row>(
    (report?.students || []).map((s: Row) => [s.clientId, s]),
  );
  const rowIds = new Set([
    ...reportRows.keys(),
    ...countByClient.keys(),
    ...rates.map((r) => r.clientId),
  ]);
  const rows = [...rowIds]
    .map(
      (clientId): Row => ({
        ...reportRows.get(clientId),
        ...(scheduling && classCountsKnown
          ? {
              completedCount: 0,
              scheduledCount: 0,
              cancelledCount: 0,
              ...countByClient.get(clientId),
            }
          : {}),
        clientId,
        rate: rates.find((r) => r.clientId === clientId),
      }),
    )
    .sort((a, b) =>
      String(names.get(a.clientId) || a.payerName || a.clientId).localeCompare(
        String(names.get(b.clientId) || b.payerName || b.clientId),
      ),
    );
  const unmatched = tableClasses.filter(
    (c) => !c.clientId && c.status !== "cancelled",
  );
  const studentPage = <StudentPageControls search={studentSearch} offset={studentOffset} total={studentTotal} count={students.length} loading={studentsLoading} error={studentsError} onSearch={value => { setStudentSearch(value); setStudentOffset(0); }} onOffset={setStudentOffset} />;
  if (!billing) return null;
  return (
    <section className="business-dashboard">
      <div className="dashboard-toolbar">
        <div>
          <h2>Prepare your monthly billing.</h2>
          <p className="muted">
            {labelMonth(month)} classes · invoices on {invoiceDay(month)}
          </p>
        </div>
        <div className="dashboard-month">
          <button
            disabled={busy}
            aria-label="Previous service month"
            onClick={() => { initializedMonth.current = true; setMonth(moveMonth(month, -1)); }}
          >
            <ChevronLeft size={16} />
          </button>
          <label><span className="sr-only">Billing service month</span><input type="month" value={month} disabled={busy} onChange={event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) { initializedMonth.current = true; setMonth(event.target.value); } }} /></label>
          <button
            disabled={busy}
            aria-label="Next service month"
            onClick={() => { initializedMonth.current = true; setMonth(moveMonth(month, 1)); }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <Notice error={error} message={notice} />
      <div className="dashboard-loading-note" role="status">{loading ? report ? `Updating billing${tableMonth !== month ? ` · showing class totals for ${labelMonth(tableMonth)}` : ""}…` : "Loading billing data…" : report && tableMonth !== month ? `Class totals shown for ${labelMonth(tableMonth)}. Refresh to try loading the selected month again.` : ""}<button disabled={loading || busy} aria-label="Refresh monthly billing" onClick={() => void load(true)}><RefreshCw size={14} /> Refresh</button></div>
          <div className="dashboard-currencies">
            {(finance?.currencies?.length
              ? finance.currencies
              : [
                  {
                    currency: "—",
                    billedMinor: 0,
                    collectedMinor: 0,
                    outstandingMinor: 0,
                    allTimeCollectedMinor: 0,
                  },
                ]
            ).map((c: Row) => (
              <div key={c.currency}>
                <span className="eyebrow">
                  {c.currency === "—"
                    ? finance ? "No financial activity yet" : loading ? "Loading financial totals…" : "Financial totals unavailable"
                    : `${c.currency} · ${labelMonth(financeMonth || moveMonth(month, 1))}`}
                </span>
                <div className="dashboard-metrics">
                  {[
                    ["All-time collected", c.allTimeCollectedMinor],
                    ["Billed this month", c.billedMinor],
                    ["Collected this month", c.collectedMinor],
                    ["Outstanding · all months", c.outstandingMinor],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <small>{String(label)}</small>
                      <strong>
                        {c.currency === "—"
                          ? "—"
                          : money(Number(value || 0), c.currency)}
                      </strong>
                    </div>
                  ))}
                </div>
                {Number(c.sandboxCollectedMinor) > 0 && (
                  <small className="muted">
                    Test payments: {money(c.sandboxCollectedMinor, c.currency)}{" "}
                    · excluded from collected revenue
                  </small>
                )}
              </div>
            ))}
          </div>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h3>Classes & monthly billing</h3>
                <small className="muted">
                  {labelMonth(tableMonth)} · Completed classes determine the invoice. Timezone:{" "}
                  {settings?.timeZone || "UTC"}
                </small>
              </div>
              <div className="dashboard-actions">
                <button
                  disabled={busy || loading || !scheduling || !settings}
                  onClick={() =>
                    void act(async () => {
                      await api("billing/v1/monthly/reconcile", "POST", {
                        month,
                        timeZone: settings?.timeZone || "UTC",
                      });
                      await load();
                      setNotice(
                        "Class records reconciled for this billing month.",
                      );
                    })
                  }
                >
                  <RefreshCw size={14} />
                  Reconcile classes
                </button>
                {manage && (
                  <>
                    <button onClick={() => setConfigure(true)}>
                      <Settings2 size={14} />
                      Billing settings
                    </button>
                    <button onClick={() => setEditor({})}>
                      <Plus size={14} />
                      Student rate
                    </button>
                    <button
                      className="primary"
                      disabled={busy || loading || !settings || tableMonth !== month}
                      onClick={() =>
                        void act(async () => {
                          await api("billing/v1/monthly/reconcile", "POST", {
                            month,
                            timeZone: settings?.timeZone || "UTC",
                          });
                          setPreview(
                            (
                              await api(
                                `billing/v1/monthly/preview?month=${month}`,
                              )
                            ).item,
                          );
                        })
                      }
                    >
                      Review monthly invoices
                    </button>
                  </>
                )}
              </div>
            </div>
            {rows.length ? (
              <div className="dashboard-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Completed</th>
                      <th>Scheduled</th>
                      <th>Cancelled</th>
                      <th>Rate / class</th>
                      <th>Month estimate</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s: Row) => (
                      <tr key={s.clientId}>
                        <td>
                          {names.get(s.clientId) ||
                            s.payerName ||
                            shortId(s.clientId)}
                        </td>
                        <td>{s.completedCount ?? "—"}</td>
                        <td>{s.scheduledCount ?? "—"}</td>
                        <td>{s.cancelledCount ?? "—"}</td>
                        <td>
                          {s.rate
                            ? money(s.rate.unitPriceMinor, s.rate.currency)
                            : "Not set"}
                        </td>
                        <td>
                          {s.rate && s.completedCount != null
                            ? money(
                                s.rate.active
                                  ? (s.completedCount || 0) *
                                      s.rate.unitPriceMinor
                                  : 0,
                                s.rate.currency,
                              )
                            : "—"}
                        </td>
                        <td>
                          {manage && (
                            <button
                              onClick={() =>
                                setEditor(s.rate || { clientId: s.clientId })
                              }
                            >
                              {s.rate ? "Edit rate" : "Set rate"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {loading ? "Class and rate records are loading. " : "No classes recorded for this month. "}Sync your calendar, then
                confirm attendance and link students below.
              </Empty>
            )}
            {unmatched.length > 0 && (
              <p className="comm-info">
                {unmatched.length} class{unmatched.length === 1 ? "" : "es"}{" "}
                need a student linked before billing.
              </p>
            )}
            <details className="dashboard-attendance">
              <summary>
                Review class attendance & student links ({tableClasses.length})
              </summary>
              <p className="muted">
                Past bookings stay scheduled until attendance is confirmed.
                Changes here affect billing; the original calendar booking
                remains visible.
              </p>
              {canReadStudents && studentPage}
              {tableClasses.map((c) => (
                <ClassAttendance
                  key={`${c.source}:${c.id || c.classId}`}
                  row={c}
                  timeZone={settings?.timeZone || "UTC"}
                  students={students}
                  disabled={busy || loading || tableMonth !== month}
                  onSave={(patch) =>
                    void act(async () => {
                      await api(
                        `scheduling/v1/class-ledger/${c.source}/${c.id || c.classId}`,
                        "PATCH",
                        patch,
                      );
                      await api("billing/v1/monthly/reconcile", "POST", {
                        month,
                        timeZone: settings?.timeZone || "UTC",
                      });
                      await load();
                    })
                  }
                />
              ))}
            </details>
          </section>
      {configure && (
        <Modal
          title="Monthly billing settings"
          onClose={() => !busy && setConfigure(false)}
        >
          <form
            className="comm-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await api("billing/v1/billing-settings", "PUT", {
                  timeZone: f.get("timeZone"),
                  autoDraft: f.get("autoDraft") === "on",
                });
                setConfigure(false);
                await load();
              });
            }}
          >
            <Notice error={error} />
            <p>
              On the first of each month, bill the previous month’s completed
              classes. For example: October 1 covers September.
            </p>
            <label>
              Business timezone
              <select
                name="timeZone"
                defaultValue={
                  settings?.timeZone ||
                  Intl.DateTimeFormat().resolvedOptions().timeZone
                }
              >
                {Array.from(
                  new Set([
                    settings?.timeZone || "UTC",
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                    ...Intl.supportedValuesOf("timeZone"),
                  ]),
                ).map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                name="autoDraft"
                defaultChecked={settings?.autoDraft}
                disabled={!settings?.automaticSupported}
              />
              Prepare invoice drafts automatically on the first
            </label>
            <small className="muted">
              Uses reconciled class records and student rates; catches up after
              downtime. Drafts stay ready for your review; this does not charge
              or message clients.
            </small>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfigure(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save settings
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editor && (
        <Modal
          title={editor.id ? "Edit student rate" : "Set student rate"}
          onClose={() => !busy && setEditor(null)}
        >
          <form
            className="comm-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                clientId = String(f.get("clientId") || editor.clientId);
              void act(async () => {
                const major = String(f.get("rate"));
                if (!/^\d+(\.\d{1,2})?$/.test(major))
                  throw new Error(
                    "Enter a rate with at most two decimal places.",
                  );
                const [whole, fraction = ""] = major.split(".");
                const amount = Number(
                  BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")),
                );
                if (!Number.isSafeInteger(amount) || amount <= 0)
                  throw new Error("Enter a positive rate.");
                await api(
                  `billing/v1/student-rates${editor.id ? `/${editor.id}` : ""}`,
                  editor.id ? "PATCH" : "POST",
                  {
                    ...(!editor.id ? { clientId } : {}),
                    payerName: String(f.get("payerName")),
                    currency: String(f.get("currency")).toUpperCase(),
                    unitPriceMinor: amount,
                    active: f.get("active") === "on",
                  },
                );
                setEditor(null);
                await load();
              });
            }}
          >
            <Notice error={error} />
            {canReadStudents && studentPage}
            <label>
              Student
              <select
                name="clientId"
                required
                defaultValue={editor.clientId || ""}
                disabled={Boolean(editor.id) || studentsLoading}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    clientId: e.target.value,
                    payerName: names.get(e.target.value) || "",
                  })
                }
              >
                <option value="">Choose a student</option>
                {editor.clientId && !students.some(student => student.id === editor.clientId) && <option value={editor.clientId}>{editor.payerName || shortId(editor.clientId)} (selected)</option>}
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Invoice payer name
              <input
                name="payerName"
                key={editor.clientId}
                defaultValue={
                  editor.payerName || names.get(editor.clientId) || ""
                }
                required
                maxLength={200}
              />
            </label>
            <div className="form-grid">
              <label>
                Price per completed class
                <input
                  name="rate"
                  inputMode="decimal"
                  required
                  defaultValue={
                    editor.unitPriceMinor
                      ? String(editor.unitPriceMinor / 100)
                      : ""
                  }
                  placeholder="For example: 25.00"
                />
              </label>
              <label>
                Currency · two decimal places
                <select name="currency" defaultValue={editor.currency || "MAD"}>
                  {["MAD", "USD", "EUR", "GBP", "CAD", "AUD"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="checkbox-row">
              <input
                name="active"
                type="checkbox"
                defaultChecked={editor.active !== false}
              />
              Include in monthly billing
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
                Save rate
              </button>
            </div>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal
          title={`Review ${labelMonth(month)} invoices`}
          onClose={() => !busy && setPreview(null)}
        >
          <Notice error={error} />
          <p className="muted">
            Due on {invoiceDay(month)} · completed classes only.
          </p>
          {preview.students.map((s: Row) => (
            <div className="record" key={s.clientId}>
              <div className="record-main">
                <strong>{s.payerName}</strong>
                <small>
                  {s.existingInvoiceId
                    ? s.completedCount
                    : (s.billableCount ?? s.completedCount)}{" "}
                  classes × {money(s.unitPriceMinor, s.currency)}
                  {s.existingInvoiceId ? " · Invoice already exists" : ""}
                </small>
              </div>
              <strong>
                {money(
                  s.existingInvoiceId
                    ? (s.existingInvoiceTotalMinor ?? s.totalMinor)
                    : s.totalMinor,
                  s.currency,
                )}
              </strong>
            </div>
          ))}
          {(preview.unrated.length > 0 || preview.unmatched.length > 0) && (
            <div className="comm-info">
              Excluded: {preview.unrated.length} classes without a rate and{" "}
              {preview.unmatched.length} classes without a linked student.
            </div>
          )}
          {preview.requiresReview.length > 0 && (
            <div className="comm-info">
              Some previously billed records changed or arrived late. Review the
              existing invoice before making adjustments.
            </div>
          )}
          <div className="form-actions">
            <button disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !preview.students.some(
                  (s: Row) => !s.existingInvoiceId && s.completedCount > 0,
                )
              }
              onClick={() =>
                void act(async () => {
                  const r = await api("billing/v1/monthly/generate", "POST", {
                    month,
                  });
                  setPreview(null);
                  await load();
                  setNotice(
                    `${r.item.created.length} draft invoices created; ${r.item.existing.length} existing invoices kept. Open Invoices to review and issue them.`,
                  );
                })
              }
            >
              Create invoice drafts
            </button>
            <button
              onClick={() => {
                setPreview(null);
                onInvoices();
              }}
            >
              Open invoices
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function StudentPageControls({ search, offset, total, count, loading, error, onSearch, onOffset }: {
  search: string; offset: number; total: number; count: number; loading: boolean; error: string;
  onSearch: (value: string) => void; onOffset: (offset: number) => void;
}) {
  return <div className="dashboard-student-picker">
    <label>Find a student for the selectors below<input type="search" value={search} maxLength={160} placeholder="Search name, email or phone" onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} onChange={event => onSearch(event.target.value)} /></label>
    <div className="dashboard-student-pages"><span role="status">{loading ? "Updating student choices…" : total ? `Showing ${offset + 1}–${Math.min(offset + count, total)} of ${total} matching students` : "No matching students"}</span><div><button type="button" disabled={loading || offset === 0} onClick={() => onOffset(Math.max(0, offset - 100))}>Previous</button><button type="button" disabled={loading || offset + 100 >= total} onClick={() => onOffset(offset + 100)}>Next</button></div></div>
    <small>Choices are loaded 100 at a time. Search or move to another page to find any student; existing selections are kept.</small>
    <Notice error={error} />
  </div>;
}
function ClassAttendance({
  row,
  timeZone,
  students,
  disabled,
  onSave,
}: {
  row: Row;
  timeZone: string;
  students: Row[];
  disabled: boolean;
  onSave: (patch: Row) => void;
}) {
  const [clientId, setClientId] = useState(row.clientId || ""),
    [status, setStatus] = useState(row.status);
  useEffect(() => {
    setClientId(row.clientId || "");
    setStatus(row.status);
  }, [row.clientId, row.status]);
  return (
    <div className="dashboard-class">
      <div>
        <strong>{row.title}</strong>
        <small>
          {new Date(row.startsAt).toLocaleString(undefined, { timeZone })} ·{" "}
          {row.attendeeEmail || row.source}
        </small>
      </div>
      <label>
        <span className="sr-only">Student for {row.title}</span>
        <select disabled={disabled} value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Link a student</option>
          {clientId && !students.some(student => student.id === clientId) && <option value={clientId}>{row.clientName || row.studentName || shortId(clientId)} (selected)</option>}
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">Attendance for {row.title}</span>
        <select disabled={disabled} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="scheduled">Scheduled</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </label>
      <button
        disabled={
          disabled ||
          (clientId === (row.clientId || "") && status === row.status)
        }
        onClick={() => onSave({ clientId: clientId || null, status })}
      >
        Save
      </button>
    </div>
  );
}
