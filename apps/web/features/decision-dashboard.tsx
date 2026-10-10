import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, CalendarDays, ChartNoAxesCombined, ChevronLeft, ChevronRight, Clock3, FileText, RefreshCw, Users, Wallet } from "lucide-react";
import {canReadFinancial} from "@palladium/contracts";
import { Empty, Notice } from "../components/shared";
import { errorMessage, money, type Api, type Business, type Row } from "../lib/api";
import { BusinessDashboard } from "./business-dashboard";
import "./decision-dashboard.css";

const sourceLabels: Record<string, string> = { clients: "Student counts", "clients.total": "Student total", "clients.active": "Active student count", "clients.leads": "Lead count", "clients.inactive": "Inactive student count", billing: "Work and financial history" };
const tabs = [
  { id: "overview", label: "Overview", icon: ChartNoAxesCombined },
  { id: "work", label: "Work tracker", icon: Clock3 },
  { id: "invoices", label: "Monthly invoices", icon: FileText },
  { id: "billing", label: "Monthly billing", icon: CalendarDays },
] as const;
type Tab = (typeof tabs)[number]["id"];
const number = (value: unknown, suffix = "") => typeof value === "number" && Number.isFinite(value)
  ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}${suffix}` : "—";
const amount = (value: unknown, currency: string) => typeof value === "number" && Number.isFinite(value) ? money(value, currency) : "—";
const monthLabel = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const moveMonth = (month: string, delta: number) => {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};
function currentMonth(timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find(part => part.type === "year")?.value}-${parts.find(part => part.type === "month")?.value}`;
}

export function DecisionDashboard({ api, business, onInvoices, onTracker, workTracker, monthlyInvoices, initialTab = "overview" }: {
  api: Api; business: Business; onInvoices: () => void; onTracker: () => void;
  workTracker?: ReactNode; monthlyInvoices?: ReactNode;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab), [month, setMonth] = useState(""), [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ api: Api; businessId: string; item: Row } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0), tabId = useId();
  const data = snapshot?.api === api && snapshot.businessId === business.id ? snapshot.item : null;
  const profileTimeZone = business.settings?.timezone;
  const displayedMonth = month || data?.month || currentMonth(profileTimeZone || "UTC");
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => { setMonth(""); setSnapshot(null); setError(""); }, [api, business.id]);
  useEffect(() => {
    if (tab !== "overview") { setLoading(false); return; }
    const request = ++sequence.current, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    setLoading(true); setError("");
    // Omitting month lets Reporting resolve the first view in the business timezone.
    void api(`reporting/v1/business-dashboard${month ? `?month=${encodeURIComponent(month)}` : ""}`, "GET", undefined, undefined, { signal: controller.signal, fresh: revision > 0 })
      .then(result => { if (request === sequence.current && !controller.signal.aborted) setSnapshot({ api, businessId: business.id, item: result.item }); })
      .catch(e => { if (request === sequence.current) setError(controller.signal.aborted ? "The dashboard took too long to respond. Refresh to try again." : errorMessage(e)); })
      .finally(() => { clearTimeout(timer); if (request === sequence.current) setLoading(false); });
    return () => { ++sequence.current; clearTimeout(timer); controller.abort(); };
  }, [api, business.id, month, tab, revision]);
  const analytics = data?.analytics, students = data?.students;
  const currencies: Row[] = analytics?.currencies ?? [];
  const viewMonth = data?.month || displayedMonth;
  const isCurrentMonth = viewMonth === currentMonth(data?.timeZone || profileTimeZone || "UTC");
  const provisional = analytics?.coverage?.provisional ?? isCurrentMonth;
  const stale = Boolean(data && viewMonth !== displayedMonth);
  const unavailable: Row[] = (data?.sources ?? []).filter((source: Row) => source.status !== "complete");
  const financialAccess = canReadFinancial(business) && business.entitlements.includes("billing");
  const visibleTabs = financialAccess ? tabs : tabs.filter(item => item.id === "overview");
  useEffect(() => { if (!financialAccess) setTab("overview"); }, [financialAccess]);
  function chooseTab(next: Tab) { setTab(next); }
  return <section className="decision-dashboard" aria-label="Business dashboard">
    <header className="decision-header">
      <div><span className="eyebrow">YOUR BUSINESS</span><h2>See where your business stands.</h2><p>Students, work and billing in one place.</p></div>
      <button onClick={onTracker}><Users size={16} /> Student tracker <ArrowUpRight size={15} /></button>
    </header>
    <div className="decision-tabs" role="tablist" aria-label="Dashboard views">
      {visibleTabs.map((item, index) => <button key={item.id} id={`${tabId}-${item.id}-tab`} role="tab" aria-selected={tab === item.id} aria-controls={`${tabId}-${item.id}-panel`} tabIndex={tab === item.id ? 0 : -1} onClick={() => chooseTab(item.id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % visibleTabs.length : event.key === "ArrowLeft" ? (index + visibleTabs.length - 1) % visibleTabs.length : event.key === "Home" ? 0 : event.key === "End" ? visibleTabs.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); chooseTab(visibleTabs[next].id); document.getElementById(`${tabId}-${visibleTabs[next].id}-tab`)?.focus();
      }}><item.icon size={16} />{item.label}</button>)}
    </div>
    <div id={`${tabId}-${tab}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}-tab`} tabIndex={0} className="decision-tab-panel">
      {tab === "work" && financialAccess && (workTracker ?? <Empty>Work history is unavailable in this workspace.</Empty>)}
      {tab === "invoices" && financialAccess && (monthlyInvoices ?? <Empty><p>Review your invoices and payment status.</p><button onClick={onInvoices}>Open invoices <ArrowUpRight size={14} /></button></Empty>)}
      {tab === "billing" && financialAccess && <BusinessDashboard key={business.id} api={api} business={business} onInvoices={onInvoices} />}
      {tab === "overview" && <>
        <div className="decision-overview-toolbar">
          <div><h3>Your month at a glance</h3><p>{data?.timeZone ? `Business timezone: ${data.timeZone}` : profileTimeZone ? `Profile timezone: ${profileTimeZone} · billing timezone unavailable` : "Business timezone unavailable"}</p></div>
          <div className="decision-month-controls">
            <button aria-label="Previous overview month" onClick={() => setMonth(moveMonth(displayedMonth, -1))}><ChevronLeft size={16} /></button>
            <label><span className="sr-only">Overview month</span><input type="month" value={displayedMonth} onChange={event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value); }} /></label>
            <button aria-label="Next overview month" onClick={() => setMonth(moveMonth(displayedMonth, 1))}><ChevronRight size={16} /></button>
            <button aria-label="Refresh overview" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} className={loading ? "decision-spinning" : ""} /></button>
          </div>
        </div>
        <div className="decision-update" role="status">{loading ? data ? `Updating${stale ? ` · showing ${monthLabel(viewMonth)}` : ""}…` : "Loading your business overview…" : data ? `As of ${new Date(data.asOf).toLocaleString()}` : "Overview figures are unavailable."}</div>
        <Notice error={error} />
        <div className="decision-summary-grid">
          <article className="decision-card decision-student-card"><div className="decision-card-label"><span>Students in your CRM</span><Users size={18} /></div><strong className="decision-large-number">{number(students?.total)}</strong><div className="decision-student-stages"><span><i />{number(students?.active)} active</span><span><i />{number(students?.leads)} leads</span><span><i />{number(students?.inactive)} inactive</span></div><small>All student records, across the business.</small></article>
          <Metric title="Students in recorded activity" value={number(analytics?.students?.tracked)} detail="Observed in work history or confirmed classes; separate from CRM counts." icon={<Clock3 size={18} />} />
          <Metric title="Recorded hours this month" value={number(analytics?.engagement?.monthHours, " h")} detail={monthLabel(viewMonth)} icon={<CalendarDays size={18} />} />
          <Metric title="Active in recorded work" value={number(analytics?.students?.activeThisMonth)} detail="Students with observed activity in the selected month." icon={<ChartNoAxesCombined size={18} />} />
        </div>
        <div className="decision-section-title"><div><h3>Money & recorded work</h3><p>Each currency is shown separately. Test payments are excluded.</p></div><button onClick={() => chooseTab("invoices")}>Review invoices <ArrowUpRight size={14} /></button></div>
        {currencies.length ? <div className="decision-money-grid">{currencies.map(currency => <article className="decision-card decision-money-card" key={currency.currency}>
          <div className="decision-card-label"><span className="eyebrow">{currency.currency}</span><Wallet size={18} /></div>
          <div className="decision-money-primary"><div><span>Pending invoice balances</span><strong>{amount(currency.pendingMinor, currency.currency)}</strong></div><div><span>Recorded work value this month</span><strong>{amount(currency.expectedThisMonthMinor, currency.currency)}</strong></div></div>
          <dl className="decision-money-details"><div><dt>Total recorded revenue · all history</dt><dd>{amount(currency.totalRecordedRevenueMinor, currency.currency)}</dd></div><div><dt>Unsent invoice balances</dt><dd>{amount(currency.unsentMinor, currency.currency)}</dd></div><div><dt>Verified collections · all history</dt><dd>{amount(currency.verifiedCollectedMinor, currency.currency)}</dd></div><div><dt>Historical paid declarations</dt><dd>{amount(currency.historicalPaidMinor, currency.currency)}</dd></div>{currency.nativeExpectedMinor != null && <div><dt>Class estimate · this month</dt><dd>{amount(currency.nativeExpectedMinor, currency.currency)}</dd></div>}{currency.ledgerPendingMinor != null && <div><dt>Work marked pending · all history</dt><dd>{amount(currency.ledgerPendingMinor, currency.currency)}</dd></div>}{currency.ledgerUnsentMinor != null && <div><dt>Work marked unsent · all history</dt><dd>{amount(currency.ledgerUnsentMinor, currency.currency)}</dd></div>}{currency.ledgerPaidMinor != null && <div><dt>Work marked paid · all history</dt><dd>{amount(currency.ledgerPaidMinor, currency.currency)}</dd></div>}</dl>
          <p className="decision-definition">Month work value covers logged work only. Class estimates cover rated, scheduled and completed classes; cancelled classes are excluded. These amounts are shown separately because their records may overlap. Historical paid declarations are imported invoice assertions; verified collections come from recorded native payments. Work statuses are tracked separately.</p>
        </article>)}</div> : <div className="decision-card decision-empty"><Wallet size={22} /><h3>{analytics ? "No financial records to show" : "Financial overview unavailable"}</h3><p>{analytics ? "Import work or invoice history to start building a picture of your business." : "Financial access or a source response is unavailable. Student figures can still appear above."}</p>{financialAccess && <button onClick={() => chooseTab("work")}>Open work tracker <ArrowUpRight size={14} /></button>}</div>}
        <div className="decision-engagement-grid">
          <article className="decision-card"><div className="decision-section-title"><div><h3>Student engagement</h3><p>{monthLabel(viewMonth)}</p></div></div><dl className="decision-engagement"><div><dt>Average recorded commitment</dt><dd>{number(analytics?.engagement?.averageCommitmentHours, " h")}</dd></div><div><dt>Average class frequency</dt><dd>{number(analytics?.engagement?.averageClassFrequency)}</dd></div><div><dt>Previous month student inactivity{provisional && <span className="decision-provisional">Provisional</span>}</dt><dd>{typeof analytics?.engagement?.churnRate === "number" ? number(analytics.engagement.churnRate * 100, "%") : "—"}</dd></div></dl><p className="decision-definition">Commitment is recorded hours per active work student this month. Frequency is confirmed classes per active class student. Inactivity is the share active last month with no recorded activity this month{isCurrentMonth ? "; this month is still in progress" : ""}. Missing data is shown as —.</p></article>
          <article className="decision-card decision-trend-card"><h3>Recorded work over time</h3><p className="decision-subtitle">Monthly hours · most recent 12 months with history; gaps mean no data</p><WorkTrend trend={analytics?.trend ?? []} /></article>
        </div>
        {analytics?.coverage?.notes?.length > 0 && <details className="decision-source-note"><summary>How these figures are calculated</summary><ul>{analytics.coverage.notes.map((note: string, index: number) => <li key={index}>{note}</li>)}</ul></details>}
        {unavailable.length > 0 && <details className="decision-source-note"><summary>Some figures are unavailable ({unavailable.length} sources)</summary><ul>{unavailable.map((source, index) => <li key={`${source.name}-${index}`}><strong>{sourceLabels[source.name] || "Dashboard source"}</strong>: {source.reason || "This source is unavailable."}</li>)}</ul></details>}
      </>}
    </div>
  </section>;
}
function Metric({ title, value, detail, icon }: { title: string; value: string; detail: string; icon: ReactNode }) {
  return <article className="decision-card"><div className="decision-card-label"><span>{title}</span>{icon}</div><strong className="decision-large-number">{value}</strong><small>{detail}</small></article>;
}
function WorkTrend({ trend }: { trend: Row[] }) {
  const entries = trend.filter(row => /^\d{4}-\d{2}$/.test(row.month)).sort((a, b) => a.month.localeCompare(b.month));
  if (!entries.length) return <div className="decision-trend-empty"><ChartNoAxesCombined size={28} /><p>No work trend available yet.</p></div>;
  const known = new Map(entries.map(row => [row.month, row])), rows: Row[] = [];
  const lastMonth = entries[entries.length - 1].month, windowStart = moveMonth(lastMonth, -11);
  for (let month = entries[0].month > windowStart ? entries[0].month : windowStart; month <= lastMonth && rows.length < 12; month = moveMonth(month, 1)) rows.push(known.get(month) ?? { month, hours: null });
  const maximum = Math.max(1, ...rows.map(row => typeof row.hours === "number" && Number.isFinite(row.hours) ? row.hours : 0));
  return <><div className="decision-trend" aria-hidden="true">{rows.map(row => <div className="decision-trend-column" key={row.month}><span className="decision-trend-value">{number(row.hours)}</span><div className="decision-trend-track">{row.hours != null && <div className="decision-trend-bar" style={{ height: `${Math.max(0, row.hours) / maximum * 100}%` }} />}</div><small>{new Date(`${row.month}-01T12:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })}<span>{row.month.slice(0, 4)}</span></small></div>)}</div><div className="sr-only"><table><caption>Recorded work trend by month. Missing hours indicate unavailable data.</caption><thead><tr><th>Month</th><th>Hours</th><th>Active students</th><th>Confirmed classes</th></tr></thead><tbody>{rows.map(row => <tr key={row.month}><th>{monthLabel(row.month)}</th><td>{number(row.hours)}</td><td>{number(row.activeStudents)}</td><td>{number(row.classes)}</td></tr>)}</tbody></table></div></>;
}
