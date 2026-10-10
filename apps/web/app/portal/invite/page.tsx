'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createApi, errorMessage, type Row } from '../../../lib/api';
import { Registration } from '../../../features/registration';
import { Notice } from '../../../components/shared';
import '../../globals.css';

export default function PortalInvitation() {
  const api = useMemo(() => createApi(), []);
  const captured = useRef(false);
  const secret = useRef<{ token: string; businessId: string } | null>(null);
  const [ready, setReady] = useState(false), [session, setSession] = useState<Row | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.hash.slice(1));
    const token = params.get('token'), businessId = params.get('business');
    url.hash = '';
    window.history.replaceState(window.history.state, '', url.pathname);
    if (token && /^[A-Za-z0-9_-]{20,512}$/.test(token) && businessId && /^[a-f\d-]{36}$/i.test(businessId))
      secret.current = { token, businessId };
    else setError('Open the full invitation link from your tutor. If it has expired, ask for a new invitation.');
    api('platform/v1/session').then(result => setSession(result.item)).catch(() => {}).finally(() => setReady(true));
  }, [api]);
  async function signedIn() {
    const result = await api('platform/v1/session');
    setSession(result.item);
  }
  async function accept() {
    if (!secret.current || busy) return;
    setBusy(true); setError('');
    try {
      await api('platform/v1/portal/accept', 'POST', secret.current);
      const businessId = secret.current.businessId;
      secret.current = null;
      window.location.replace(`/portal?business=${encodeURIComponent(businessId)}`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  if (!ready) return <main className="loading-screen"><p>Opening your invitation…</p></main>;
  if (secret.current && !session) return <Registration api={api} onSignedIn={signedIn} audience="student" />;
  return <main className="onboarding"><section className="panel" style={{ maxWidth: 560, margin: '8vh auto', padding: '2rem' }}>
    <div className="wordmark">tuts</div>
    <h1>Your learning space</h1>
    <Notice error={error} />
    {secret.current && session && <>
      <p>Signed in as <strong>{session.user.email}</strong>. Accept this invitation to access the student record your tutor shared.</p>
      <button className="primary full" disabled={busy} onClick={() => void accept()}>{busy ? 'Opening…' : 'Accept invitation'}</button>
      <button className="link" disabled={busy} onClick={async () => { try { await api('platform/auth/sign-out', 'POST', {}); setSession(null); } catch (failure) { setError(errorMessage(failure)); } }}>Use a different account</button>
    </>}
    {!secret.current && <a href="/portal">Go to your student portal</a>}
    <p className="small-note">Invitation links are private. Your tutor controls which student records you can access.</p>
  </section></main>;
}
