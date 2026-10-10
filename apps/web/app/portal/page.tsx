"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { GraduationCap, LogOut } from "lucide-react";
import { hasPermission } from "@palladium/contracts";
import { clearApi, createApi, date, errorMessage, type Api, type Business, type Row } from "../../lib/api";
import { Empty, Notice } from "../../components/shared";
import { Registration } from "../../features/registration";
import { PortalLearning } from "./portal-learning";
import { StudentBoards } from "../../features/student-boards";
import { clearHomeworkDrafts } from "../../lib/homework-draft";
import { installClientDiagnostics, portalDiagnosticView } from "../../lib/client-diagnostics";
import { useActiveTime } from "./use-active-time";
import "../globals.css";
import "../../features/teaching-ux.css";
import "./portal.css";

function portalTheme(business: Business): CSSProperties {
  const branding = business.settings?.branding ?? {}, colors: Record<string, string> = {};
  for (const [key, variable] of Object.entries({ primaryColor: "--accent", backgroundColor: "--background", textColor: "--ink" })) if (/^#[a-f\d]{6}$/i.test(branding[key] ?? "")) colors[variable] = branding[key];
  if (colors["--accent"]) { const value = colors["--accent"]; colors["--on-accent"] = (parseInt(value.slice(1, 3), 16) * 299 + parseInt(value.slice(3, 5), 16) * 587 + parseInt(value.slice(5, 7), 16) * 114) / 1000 > 160 ? "#17251e" : "#fff"; }
  return colors as CSSProperties;
}

export default function StudentPortal() {
  const platform = useMemo(() => createApi(), []);
  const [session, setSession] = useState<Row | null>(null), [businesses, setBusinesses] = useState<Business[]>([]), [business, setBusiness] = useState<Business | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try {
      const result = await platform("platform/v1/session"); setSession(result.item);
      if (result.item) {
        const data = await platform("platform/v1/businesses"), allowed = (data.items ?? []).filter((item: Business) => item.entitlements.includes("clients") && hasPermission(item, "clients.read"));
        setBusinesses(allowed); const requested = new URLSearchParams(window.location.search).get("business");
        setBusiness(allowed.find((item: Business) => item.id === requested) ?? allowed.find((item: Business) => ["student", "parent"].includes(item.role)) ?? allowed[0] ?? null);
      }
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [platform]);
  function choose(selected: Business) { setBusiness(selected); const url = new URL(window.location.href); url.searchParams.set("business", selected.id); url.searchParams.delete("student"); url.searchParams.delete("board"); window.history.replaceState(null, "", url); }
  async function signOut() { try { await platform("platform/auth/sign-out", "POST", {}); try { clearHomeworkDrafts(window.sessionStorage, session?.user?.id ?? ""); } catch {} setSession(null); setBusiness(null); setBusinesses([]); } catch (e) { setError(errorMessage(e)); } }
  if (loading) return <main className="loading-screen"><GraduationCap size={32} /><p>Opening your learning space…</p></main>;
  if (!session) return <><Notice error={error} /><Registration api={platform} audience="student" onSignedIn={load} /></>;
  if (!business) return <main className="portal-shell"><div className="portal-header"><div className="wordmark"><GraduationCap />tuts</div><button onClick={() => void signOut()}>Sign out</button></div><Notice error={error} /><Empty><h1>Your learning space is waiting.</h1><p>Open the full invitation link from your tutor and sign in using the invited email to accept access.</p><button onClick={() => void load()}>Refresh access</button></Empty></main>;
  return <main className="portal-shell" style={portalTheme(business)}>
    <header className="portal-header"><div className="wordmark"><GraduationCap />tuts</div><div className="portal-header-actions">{businesses.length > 1 && <label>Learning space<select aria-label="Choose learning space" value={business.id} onChange={(e) => { const next = businesses.find((item) => item.id === e.target.value); if (next) choose(next); }}>{businesses.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}{businesses.some((item) => ["owner", "admin", "tutor"].includes(item.role)) && <a href="/">Tutor workspace</a>}<button onClick={() => void signOut()}><LogOut size={16} /> Sign out</button></div></header>
    <Notice error={error} /><PortalWorkspace key={business.id} platform={platform} business={business} authorId={session.user.id} />
  </main>;
}

// A dedicated component keeps the business API stable between portal renders.
function PortalWorkspace({ platform, business, authorId }: { platform: Api; business: Business; authorId: string }) {
  const capabilityKey = JSON.stringify([authorId,business.role,business.permissions,business.entitlements,business.accessScope,business.studentIds]);
  const api = useMemo(() => createApi(business.id), [business.id,capabilityKey]);
  useEffect(() => () => clearApi(api), [api]);
  const [grants, setGrants] = useState<Row[]>([]), [students, setStudents] = useState<Row[]>([]), [selected, setSelected] = useState<Row | null>(null), [studentOffset, setStudentOffset] = useState(0), [tab, setTab] = useState(() => typeof window === "undefined" ? "homework" : new URLSearchParams(window.location.search).get("section") ?? "homework"), [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const diagnosticView = useRef(tab);
  diagnosticView.current = portalDiagnosticView(tab);
  useEffect(() => installClientDiagnostics(api, () => diagnosticView.current), [api]);
  const available = (domain: string) => business.entitlements.includes(domain) && hasPermission(business, `${domain}.read`);
  const trackingAllowed = business.role === "student" && grants.some((grant) => grant.studentId === selected?.id && grant.relationship === "student") && business.entitlements.includes("reporting") && hasPermission(business, "reporting.write");
  useActiveTime(api, selected?.id, trackingAllowed);
  const tabs = [...(available("learning") ? ["homework", "resources"] : []), ...(available("integrations") ? ["booking"] : []), ...(available("scheduling") ? ["sessions"] : []), ...(available("planning") ? ["planning"] : []), "contacts"];
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0] ?? ""); }, [tabs.join(","), tab]);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError(""); setStudents([]); setSelected(null);
    async function loadStudents() {
      const result = await platform(`platform/v1/portal/access?businessId=${encodeURIComponent(business.id)}`), access = result.items ?? [];
      if (cancelled) return; setGrants(access);
      const ids = [...new Set<string>(access.map((grant: Row) => grant.studentId))], found: Row[] = [];
      for (let at = studentOffset; at < Math.min(studentOffset + 50, ids.length); at += 5) {
        const batch = await Promise.all(ids.slice(at, Math.min(at + 5, studentOffset + 50)).map((id) => api(`clients/v1/portal/students/${id}`)));
        if (cancelled) return; found.push(...batch.map((item) => item.item));
      }
      if (!cancelled) { setStudents(found); const requested = new URLSearchParams(window.location.search).get("student"); setSelected(found.find((student) => student.id === requested) ?? found[0] ?? null); }
    }
    loadStudents().catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, platform, business.id, studentOffset, revision]);
  useEffect(() => {
    const restore = () => {
      const query = new URLSearchParams(window.location.search);
      setTab(query.get("section") ?? "homework");
      const student = students.find(row => row.id === query.get("student"));
      if (student) setSelected(student);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [students]);
  function chooseTab(name: string) {
    setTab(name);
    const url = new URL(window.location.href);
    url.searchParams.set("section", name);
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, name: string) {
    const at = tabs.indexOf(name);
    const next = event.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(at + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null;
    if (!next) return;
    event.preventDefault(); chooseTab(next);
    document.getElementById(`portal-tab-${next}`)?.focus();
  }
  const studentCount = new Set(grants.map((grant) => grant.studentId)).size;
  if (loading) return <Empty>Loading your shared student records…</Empty>;
  return <>
    <Notice error={error} />
    {!selected ? <Empty><h2>No student record is shared with this account.</h2><p>Use the invitation from your tutor and accept it while signed in with the invited email.</p><button onClick={() => setRevision((n) => n + 1)}>Refresh access</button></Empty> : <>
      <div className="portal-welcome"><span className="portal-photo">{selected.photo ? <img src={selected.photo} alt="" /> : String(selected.displayName || "?")[0]}</span><div><h1>{selected.displayName}</h1><p className="muted">Your learning space with {business.name}.</p></div></div>
      <div className="portal-student-switch">{students.length > 1 && <label>Student<select aria-label="Choose shared student" value={selected.id} onChange={(e) => { const next = students.find((student) => student.id === e.target.value); if (next) { setSelected(next); const url = new URL(window.location.href); url.searchParams.set("student", next.id); url.searchParams.delete("board"); window.history.replaceState(null, "", url); } }}>{students.map((student) => <option value={student.id} key={student.id}>{student.displayName}</option>)}</select></label>}<span className="tag">{grants.find((grant) => grant.studentId === selected.id)?.relationship === "guardian" ? "Guardian access" : "Student access"}</span><button onClick={() => setRevision((n) => n + 1)}>Refresh access</button></div>
      {studentCount > 50 && <div className="portal-pagination"><span>Students {studentOffset + 1}–{Math.min(studentOffset + 50, studentCount)} of {studentCount}</span><button disabled={studentOffset === 0} onClick={() => setStudentOffset((n) => Math.max(0, n - 50))}>Previous students</button><button disabled={studentOffset + 50 >= studentCount} onClick={() => setStudentOffset((n) => n + 50)}>Next students</button></div>}
      <nav className="portal-tabs" role="tablist" aria-label="Learning sections">{tabs.map((name) => <button key={name} role="tab" id={`portal-tab-${name}`} aria-controls="portal-section" tabIndex={tab === name ? 0 : -1} aria-selected={tab === name} onKeyDown={event => tabKey(event, name)} onClick={() => chooseTab(name)}>{({ homework: "Homework", resources: "Resources", booking: "Book a session", sessions: "Sessions", planning: "Planning", contacts: "Contacts" } as Record<string, string>)[name]}</button>)}</nav>
      <section id="portal-section" role="tabpanel" aria-labelledby={`portal-tab-${tab}`} tabIndex={-1}>
      {tabs.includes(tab) && ["homework", "resources"].includes(tab) && <PortalLearning key={`${business.id}:${selected.id}:${tab}`} api={api} businessId={business.id} authorId={authorId} studentId={selected.id} resourcesOnly={tab === "resources"} canSubmit={hasPermission(business, "learning.write")} />}
      {tabs.includes(tab) && tab === "booking" && <PortalBooking api={api} studentId={selected.id} />}
      {tabs.includes(tab) && tab === "sessions" && <PortalSessions api={api} studentId={selected.id} />}
      {tabs.includes(tab) && tab === "planning" && <StudentBoards key={selected.id} api={api} business={business} studentId={selected.id} student={selected} persistNavigation />}
      {tab === "contacts" && <div className="portal-grid">{selected.contacts?.map((contact: Row) => <article className="portal-card" key={contact.id}><h3>{contact.displayName}</h3><span className="tag">{({ student: "Student", self: "Student", parent: "Parent", guardian: "Guardian", sponsor: "Sponsor / payer", other: "Other" } as Record<string, string>)[contact.relationship] ?? contact.relationship}</span>{contact.isPrimary && <span className="tag">Primary contact</span>}{contact.emails?.map((email: Row) => <p key={email.id}>{email.value}{email.isPrimary ? " · primary email" : ""}</p>)}{contact.phones?.map((phone: Row) => <p key={phone.id}>{phone.value}{phone.isPrimary ? " · primary phone" : ""}</p>)}</article>)}</div>}
      </section>
      {!tabs.length && <Empty>Your tutor has not enabled learning or booking features in this space.</Empty>}
    </>}
  </>;
}

function safeCalUrl(value: unknown) { try { const url = new URL(String(value)); return url.protocol === "https:" && url.hostname === "cal.com" && !url.username && !url.password ? url : null; } catch { return null; } }
function PortalBooking({ api, studentId }: { api: Api; studentId: string }) {
  const [items, setItems] = useState<Row[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => { let cancelled = false; setLoading(true); setItems([]); setError(""); api(`integrations/v1/portal/booking?studentId=${encodeURIComponent(studentId)}`).then((data) => { if (!cancelled) setItems(data.items ?? []); }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [api, studentId]);
  return <><Notice error={error} />{loading ? <Empty>Loading your tutor's booking options…</Empty> : !items.length && !error ? <Empty><h3>Booking isn’t available yet.</h3><p>Your tutor has not shared a booking calendar. Contact them to arrange a session.</p></Empty> : <div className="portal-grid">{items.map((item) => { const url = safeCalUrl(item.bookingUrl); if (url && item.prefill?.name) url.searchParams.set("name", item.prefill.name); if (url && item.prefill?.email) url.searchParams.set("email", item.prefill.email); return <article className="portal-card" key={item.id}><h3>{item.displayName}</h3><p>Choose a time using your tutor's Cal.com booking page.</p>{url ? <a className="button primary" href={url.href} target="_blank" rel="noopener noreferrer">Open booking calendar</a> : <p className="crm-helper">Booking link unavailable.</p>}<p className="portal-external-notice">Cal.com manages availability and booking changes. Your name and authorized contact email may be prefilled; changing those fields does not change your portal access.</p><p className="crm-helper">{item.syncAvailable ? "Bookings are synchronized after your tutor associates them with your student record." : "Your tutor may need to link your booking before it appears in your session list."}</p></article>; })}</div>}</>;
}
function PortalSessions({ api, studentId }: { api: Api; studentId: string }) {
  const [items, setItems] = useState<Row[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => { setOffset(0); }, [studentId]);
  useEffect(() => { let cancelled = false; setLoading(true); setError(""); api(`scheduling/v1/portal/sessions?${new URLSearchParams({ studentId, limit: "20", offset: String(offset) })}`).then((data) => { if (!cancelled) { setItems(data.items ?? []); setTotal(data.total ?? 0); } }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [api, studentId, offset, revision]);
  return <><Notice error={error} /><button disabled={loading} onClick={() => setRevision((n) => n + 1)}>Refresh sessions</button>{loading ? <Empty>Loading sessions…</Empty> : !items.length && !error ? <Empty>No sessions have been linked to this student yet.</Empty> : <div className="portal-session-list" style={{ marginTop: 18 }}>{items.map((item) => { const url = safeCalUrl(item.bookingUrl); return <article className="portal-card" key={`${item.source}:${item.id}`}><div><h3>{item.title}</h3><p>{date(item.startsAt)} – {date(item.endsAt)}</p><span className={`status ${item.status}`}>{({ scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", no_show: "No-show" } as Record<string, string>)[item.status] ?? item.status}</span></div>{url && <a href={url.href} target="_blank" rel="noopener noreferrer">Manage booking in Cal.com</a>}</article>; })}</div>}{items.some(item => safeCalUrl(item.bookingUrl)) && <p className="portal-external-notice">Need to change a booking? Open its Cal.com link above.</p>}{total > 20 && <div className="portal-pagination"><span>{total ? `${offset + 1}–${Math.min(offset + items.length, total)} of ${total}` : ""}</span><button disabled={loading || offset === 0} onClick={() => setOffset((n) => Math.max(0, n - 20))}>Previous</button><button disabled={loading || offset + 20 >= total} onClick={() => setOffset((n) => n + 20)}>Next</button></div>}</>;
}
