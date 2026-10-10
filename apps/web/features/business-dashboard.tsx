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
    [notice, setNotice] = useState("");
  const manage = hasPermission(business, 'billing.manage'),
    billing = business.entitlements.includes("billing") && hasPermission(business, 'billing.read'),
    scheduling = business.entitlements.includes("scheduling") && hasPermission(business, 'scheduling.read');
  const loadSequence = useRef(0);
  const initializedMonth = useRef(false);
  async function contacts() {
    if (!business.entitlements.includes("clients") || !hasPermission(business, 'clients.read')) return [];
    const all: Row[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const r = await api(
        `clients/v1/clients?kind=student&limit=100&offset=${offset}`,
      );
      all.push(...r.items);
      if (all.length >= r.total || r.items.length < 100) break;
    }
    return all;
  }
  async function load() {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      if (!billing) return;
      const [s, r, c] = await Promise.all([
        api("billing/v1/billing-settings"),
        api("billing/v1/student-rates"),
        contacts(),
      ]);
      if (sequence !== loadSequence.current) return;
      setSettings(s.item);
      setRates(r.items);
      setStudents(c);
      if (!initializedMonth.current) {
        initializedMonth.current = true;
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: s.item.timeZone,
          year: "numeric",
          month: "2-digit",
        }).formatToParts(new Date());
        const current = `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
        const initial = moveMonth(current, -1);
        if (initial !== month) {
          setMonth(initial);
          return;
        }
      }
      const [d, f, l] = await Promise.all([
        api(`billing/v1/dashboard?month=${month}`),
        api(`billing/v1/dashboard?month=${moveMonth(month, 1)}`),
        scheduling
          ? api(
              `scheduling/v1/class-ledger?month=${month}&timeZone=${encodeURIComponent(s.item.timeZone)}`,
            )
          : Promise.resolve({ items: [] }),
      ]);
      if (sequence !== loadSequence.current) return;
      setReport(d.item);
      setFinance(f.item);
      setClasses(l.items);
      setError("");
    } catch (e) {
      if (sequence === loadSequence.current) setError(errorMessage(e));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    setPreview(null);
    return () => {
      loadSequence.current++;
    };
  }, [api, month]);
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
  const countByClient = new Map<string, Row>();
  for (const c of classes) {
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
        ...(scheduling
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
  const unmatched = classes.filter(
    (c) => !c.clientId && c.status !== "cancelled",
  );
  if (!billing) return null;
  return (
    <section className="business-dashboard">
      <div className="dashboard-toolbar">
        <div>
          <h2>Your business, month by month.</h2>
          <p className="muted">
            {labelMonth(month)} classes · invoices on {invoiceDay(month)}
          </p>
        </div>
        <div className="dashboard-month">
          <button
            disabled={busy || loading}
            aria-label="Previous service month"
            onClick={() => setMonth(moveMonth(month, -1))}
          >
            <ChevronLeft size={16} />
          </button>
          <strong>{labelMonth(month)}</strong>
          <button
            disabled={busy || loading}
            aria-label="Next service month"
            onClick={() => setMonth(moveMonth(month, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <Notice error={error} message={notice} />
      {loading && !report ? (
        <div className="panel">Loading your business dashboard…</div>
      ) : (
        <>
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
                    ? "No financial activity yet"
                    : `${c.currency} · ${labelMonth(moveMonth(month, 1))}`}
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
                  Completed classes determine the invoice. Timezone:{" "}
                  {settings?.timeZone || "UTC"}
                </small>
              </div>
              <div className="dashboard-actions">
                <button
                  disabled={busy || !scheduling}
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
                      disabled={busy}
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
                        <td>{s.completedCount || 0}</td>
                        <td>{s.scheduledCount || 0}</td>
                        <td>{s.cancelledCount || 0}</td>
                        <td>
                          {s.rate
                            ? money(s.rate.unitPriceMinor, s.rate.currency)
                            : "Not set"}
                        </td>
                        <td>
                          {s.rate
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
                No classes recorded for this month. Sync your calendar, then
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
                Review class attendance & student links ({classes.length})
              </summary>
              <p className="muted">
                Past bookings stay scheduled until attendance is confirmed.
                Changes here affect billing; the original calendar booking
                remains visible.
              </p>
              {classes.map((c) => (
                <ClassAttendance
                  key={`${c.source}:${c.id || c.classId}`}
                  row={c}
                  timeZone={settings?.timeZone || "UTC"}
                  students={students}
                  disabled={busy}
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
        </>
      )}
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
            <label>
              Student
              <select
                name="clientId"
                required
                defaultValue={editor.clientId || ""}
                disabled={Boolean(editor.id)}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    clientId: e.target.value,
                    payerName: names.get(e.target.value) || "",
                  })
                }
              >
                <option value="">Choose a student</option>
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
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Link a student</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">Attendance for {row.title}</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
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
