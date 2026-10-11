import { useEffect, useState } from 'react';
import { canReadFinancial, hasPermission } from '@palladium/contracts';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Empty, Notice } from '../components/shared';
import { errorMessage, money, type Api, type Business, type Row } from '../lib/api';
import { useListOffset } from '../lib/use-list-query';
import './work-history.css';

export function StudentWorkHistory({ api, business, studentId, month, onMonthChange }: {
  api: Api; business: Business; studentId: string; month: string; onMonthChange: (month: string) => void;
}) {
  const [allMonths, setAllMonths] = useState(false), [revision, setRevision] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<{api:Api;studentId:string;item:Row} | null>(null);
  const [offset, setOffset] = useListOffset(`${business.id}:${studentId}:${month}:${allMonths}`), limit = 50;
  const allowed = canReadFinancial(business) && business.entitlements.includes('billing') && business.entitlements.includes('clients') && hasPermission(business, 'clients.read');
  const data = snapshot?.api === api && snapshot.studentId === studentId ? snapshot.item : null;
  useEffect(() => {
    if (!allowed) {setSnapshot(null); return;}
    const controller = new AbortController(); setLoading(true); setError('');
    const params = new URLSearchParams({limit:String(limit),offset:String(offset)}); if (!allMonths) params.set('month',month);
    api(`billing/v1/students/${encodeURIComponent(studentId)}/work-history?${params}`, 'GET', undefined, undefined, {signal:controller.signal,fresh:revision>0})
      .then(result => {if (!controller.signal.aborted) setSnapshot({api,studentId,item:result.item});})
      .catch(e => {if (!controller.signal.aborted) setError(errorMessage(e));})
      .finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [api, business.id, studentId, month, allMonths, offset, revision, allowed]);
  if (!allowed) return <Empty>Work history requires business financial access.</Empty>;
  return <section className="work-history" aria-label="Student work history">
    <div className="work-filters"><label>Work month<input type="month" value={month} disabled={allMonths || loading} onChange={event => {if (event.target.value) onMonthChange(event.target.value);}} /></label><label className="work-checkbox"><input type="checkbox" checked={allMonths} onChange={event=>setAllMonths(event.target.checked)} />All history</label><button aria-label="Refresh student work history" disabled={loading} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={16} /></button></div>
    <Notice error={error} />
    {loading && <p role="status">{data ? 'Updating recorded work…' : 'Loading recorded work…'}</p>}
    <p className="work-help">Reviewed work linked to this student. Paid, pending and unsent are declarations from your imported tracker; invoices and verified payments appear in Payments.</p>
    <div className="work-total-grid">{data?.currencies?.map((currency:Row)=><article key={currency.currency}><span>{currency.currency} · {allMonths ? 'all history' : data.month}</span><strong>{Number(allMonths ? currency.totalHours : currency.monthHours).toLocaleString()} hours</strong><span>{money(allMonths ? currency.totalMinor : currency.monthMinor,currency.currency)}</span><small>All history · Unsent {money(currency.unsentMinor,currency.currency)} · Pending {money(currency.pendingMinor,currency.currency)} · Paid {money(currency.paidMinor,currency.currency)}</small></article>)}</div>
    {!loading && !error && !data?.rows?.length && <Empty>No reviewed work linked to this student{allMonths ? '.' : ' this month. Select All history to see other months.'}</Empty>}
    {Boolean(data?.rows?.length) && <div className="work-table-wrap" aria-busy={loading}><table><thead><tr>{['Date','Service','Hours','Value','Status'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{data?.rows?.map((row:Row)=><tr key={row.id}><td>{row.date}</td><td>{row.serviceType || 'Work'}</td><td>{row.hours}</td><td>{money(row.amountMinor,row.currency)}</td><td>{({paid:'Paid',pending:'Pending',unsent:'Unsent'} as Record<string,string>)[row.status] || row.status}</td></tr>)}</tbody></table></div>}
    {(data?.total || 0)>limit && <div className="work-actions"><button disabled={loading || offset===0} onClick={()=>setOffset(value=>Math.max(0,value-limit))}><ChevronLeft size={16} />Previous</button><span>Records {offset+1}–{Math.min(data?.total||0,offset+limit)} of {data?.total}</span><button disabled={loading || offset+limit>=(data?.total || 0)} onClick={()=>setOffset(value=>value+limit)}>Next<ChevronRight size={16} /></button></div>}
  </section>;
}
