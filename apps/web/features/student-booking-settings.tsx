import { useEffect, useState, type FormEvent } from 'react';
import { hasPermission } from '@palladium/contracts';
import { errorMessage, gateway, type Api, type Business, type Row } from '../lib/api';
import { Modal, Notice } from '../components/shared';

/** Tutor-owned configuration; provider credentials stay in Integrations. */
export function StudentBookingSettings({ api, business, userId }: { api: Api; business: Business; userId: string }) {
  const [config, setConfig] = useState<Row | null>(null), [connections, setConnections] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [rotating, setRotating] = useState<Row | null>(null), [receipt, setReceipt] = useState<Row | null>(null);
  const canWrite = hasPermission(business, 'integrations.write');
  const canManage = hasPermission(business, 'integrations.manage');
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setReceipt(null);
    Promise.all([api('integrations/v1/portal/booking-config'), business.accessScope === 'students' ? Promise.resolve({items: []}) : api('integrations/v1/connections')]).then(([own, all]) => {
      if (!cancelled) { setConfig(own.item); setConnections((all.items ?? []).filter((row: Row) => row.provider === 'calcom' && row.status !== 'disconnected')); }
    }).catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, business.id]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canWrite) return;
    const form = new FormData(event.currentTarget); setBusy(true); setError(''); setMessage('');
    try {
      const result = await api('integrations/v1/portal/booking-config', 'PUT', {
        displayName: String(form.get('displayName')).trim(), bookingUrl: String(form.get('bookingUrl')).trim(),
        connectionId: form.get('connectionId') || null, enabled: form.get('enabled') === 'on',
      });
      setConfig(result.item); setMessage('Student booking settings saved.');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function webhook() {
    if (!rotating || !canManage) return; setBusy(true); setError('');
    try {
      const result = await api(`integrations/v1/connections/${rotating.id}/calcom-webhook`, 'POST', {});
      setReceipt(result); setConnections(rows => rows.map(row => row.id === result.item.id ? result.item : row)); setRotating(null);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <section className="panel" style={{ marginTop: 24 }}>
    <h2>Student booking</h2><p className="muted">Choose the Cal.com calendar students can open from their portal.</p>
    <Notice error={error} message={message} />
    {loading ? <p>Loading booking settings…</p> : <form key={config?.updatedAt ?? 'new'} onSubmit={save}>
      <div className="form-grid"><label>Tutor / calendar name<input name="displayName" defaultValue={config?.displayName ?? business.name} required maxLength={100} disabled={!canWrite || busy} /></label>
      <label>Public Cal.com link<input name="bookingUrl" type="url" placeholder="https://cal.com/your-name/lesson" defaultValue={config?.bookingUrl ?? ''} required maxLength={2048} disabled={!canWrite || busy} /></label>
      <label>Calendar synchronization<select name="connectionId" defaultValue={config?.connectionId ?? ''} disabled={!canWrite || busy}><option value="">Booking link only</option>{config?.connectionId && !connections.some(row => row.id === config.connectionId) && <option value={config.connectionId}>Current connected calendar</option>}{connections.filter(row => row.ownerUserId === userId).map(row => <option key={row.id} value={row.id}>{row.displayName}</option>)}</select></label></div>
      <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={config?.enabled ?? true} disabled={!canWrite || busy} /> Show this calendar in the student portal</label>
      <p className="crm-helper">A public link is enough for booking. Connect a Cal.com API key above to synchronize sessions. Tutors review which student each imported booking belongs to.</p>
      {canWrite && <div className="form-actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save booking settings'}</button></div>}
    </form>}
    {canManage && connections.length > 0 && <details style={{ marginTop: 20 }}><summary>Receive booking changes from Cal.com</summary><p>Set up a webhook in Cal.com for faster updates. Scheduled synchronization remains available.</p>{connections.map(row => <div className="toolbar" key={row.id}><strong>{row.displayName}</strong><span>{row.calWebhookConfigured ? 'Webhook secret configured' : 'Webhook not configured'}</span><button disabled={busy} onClick={() => { setReceipt(null); setRotating(row); }}>{row.calWebhookConfigured ? 'Replace webhook secret' : 'Set up webhook'}</button></div>)}</details>}
    {rotating && <Modal title="Set up Cal.com updates" onClose={() => { if (!busy) setRotating(null); }}><Notice error={error} /><p>{rotating.calWebhookConfigured ? 'Replacing this secret stops the existing webhook until you update its secret in Cal.com.' : 'This creates a secret to copy into your Cal.com webhook settings.'}</p><div className="form-actions"><button disabled={busy} onClick={() => setRotating(null)}>Cancel</button><button className="primary" disabled={busy} onClick={() => void webhook()}>{busy ? 'Preparing…' : 'Create secret'}</button></div></Modal>}
    {receipt && <Modal title="Finish webhook setup in Cal.com" onClose={() => setReceipt(null)}><p>Add a webhook in your Cal.com settings using these values. The secret is shown once; closing this dialog clears it.</p><label>Subscriber URL<input readOnly value={`${gateway || window.location.origin}${receipt.webhookPath}`} onFocus={e => e.currentTarget.select()} /></label><label>Secret<input readOnly value={receipt.webhookSecret} onFocus={e => e.currentTarget.select()} autoComplete="off" /></label><p>Enable: {receipt.triggers.join(', ')}.</p><p className="crm-helper">Registration with Cal.com is still required. Creating this secret does not register the provider webhook.</p><button onClick={() => setReceipt(null)}>Done</button></Modal>}
  </section>;
}
