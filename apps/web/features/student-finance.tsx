import { useEffect, useState } from "react";
import { hasPermission } from "@palladium/contracts";
import { date, errorMessage, money, type Api, type Business, type Row } from "../lib/api";
import { Empty, Notice } from "../components/shared";
import "./student-reporting.css";

export function StudentFinance({ api, business, studentId }: { api: Api; business: Business; studentId: string }) {
  const allowed = business.entitlements.includes("billing") && hasPermission(business, "billing.read");
  const [data, setData] = useState<Row | null>(null), [view, setView] = useState("invoices"), [offset, setOffset] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => { setOffset(0); setData(null); }, [studentId, view, business.id]);
  useEffect(() => {
    let cancelled = false; setError(""); setData(null); if (!allowed) { setLoading(false); return; } setLoading(true);
    api(`billing/v1/portal/finance?${new URLSearchParams({ studentId, limit: "20", offset: String(offset) })}`).then((result) => { if (!cancelled) setData(result); }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, allowed, studentId, view, offset, revision, business.id]);
  if (!allowed) return <Empty>Financial records are not available with your current access.</Empty>;
  const items: Row[] = data?.[view === "invoices" ? "items" : "payments"] ?? [], total = data?.[view === "invoices" ? "total" : "paymentTotal"] ?? 0;
  return <section className="student-finance" aria-label="Student financial records">
    <Notice error={error} />
    <div className="tracker-actions" style={{ marginBottom: 18 }}><button disabled={loading} onClick={() => setRevision((n) => n + 1)}>Refresh financial records</button><span className="tag">All time · issued invoices and recorded payments</span></div>
    {data?.asOf && <p className="crm-helper">Updated {date(data.asOf)}. Issued invoices preserve their original recipient and amounts after a student merge.</p>}
    {loading ? <Empty>Loading financial records…</Empty> : data && <>
      <div className="tracker-financial-totals">{data.totals?.map((total: Row) => <div className="tracker-detail-item" key={total.currency}><strong>{total.currency}</strong><dl className="tracker-properties"><div><dt>Billed</dt><dd>{money(total.billedMinor, total.currency)}</dd></div><div><dt>Collected</dt><dd>{money(total.collectedMinor, total.currency)}</dd></div><div><dt>Outstanding</dt><dd>{money(total.outstandingMinor, total.currency)}</dd></div>{total.simulatedMinor > 0 && <div><dt>Sandbox simulations</dt><dd>{money(total.simulatedMinor, total.currency)}</dd></div>}</dl></div>)}</div>
      <div className="tracker-actions" style={{ margin: "20px 0" }}><button aria-pressed={view === "invoices"} onClick={() => setView("invoices")}>Issued invoices ({data.total})</button><button aria-pressed={view === "payments"} onClick={() => setView("payments")}>Recorded payments ({data.paymentTotal})</button></div>
      {!items.length ? <Empty>{view === "invoices" ? "No issued invoices on this page." : "No recorded payments on this page."}</Empty> : <div className="tracker-detail-list">{items.map((item) => <article className="tracker-detail-item" key={item.id}>{view === "invoices" ? <><h3>Invoice · …{String(item.id).slice(-8)}</h3><span className={`status ${item.status}`}>{item.status}</span><p>{money(item.totalMinor, item.currency)}</p><p className="crm-helper">Recipient: {item.payerName}. Issued {date(item.issuedAt)}{item.dueAt ? ` · Due ${date(item.dueAt)}` : ""}</p>{item.serviceMonth && <p className="crm-helper">Service month: {typeof item.serviceMonth === "string" ? item.serviceMonth : item.serviceMonth.month ?? item.serviceMonth.period ?? "Recorded on invoice"}</p>}{item.items?.map((line: Row, index: number) => <p key={index}>{line.description ?? line.title ?? "Invoice item"}{line.quantity != null ? ` · ${line.quantity}` : ""}</p>)}</> : <><h3>{item.simulated ? "Sandbox simulation" : "Recorded payment"}</h3><p>{money(item.amountMinor, item.currency)}</p><span className="tag">{item.simulated ? "Simulated · excluded from collections" : "Recorded collection"}</span><p className="crm-helper">{date(item.createdAt)} · {item.provider} · Invoice …{String(item.invoiceId).slice(-8)}</p></>}</article>)}</div>}
      <p className="crm-helper">Collections and outstanding balances use real recorded payments. Sandbox simulations are shown separately.</p>
      <div className="pagination"><span>{total ? `${offset + 1}–${Math.min(offset + items.length, total)} of ${total}` : ""}</span><button disabled={loading || offset === 0} onClick={() => setOffset((n) => Math.max(0, n - 20))}>Previous</button><button disabled={loading || offset + 20 >= total} onClick={() => setOffset((n) => n + 20)}>Next</button></div>
    </>}
  </section>;
}
