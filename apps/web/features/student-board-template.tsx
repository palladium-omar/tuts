import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, GraduationCap, Sparkles } from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Notice } from "../components/shared";
import { deadlineTime, publicLink } from "./student-board-card";
import { applicationCycle, currentAcademicYear, planningProfileKey, type PlanningProfile } from "../lib/application-cycle";

const paths = [
  { key: "ucas", name: "UCAS", detail: "Apply to universities in the UK", mark: "UK" },
  { key: "common-app", name: "Common App", detail: "Build your US college applications", mark: "US" },
  { key: "bocconi", name: "Bocconi", detail: "Plan your application to Bocconi", mark: "IT" },
  { key: "campus-france", name: "Campus France", detail: "Prepare your Études en France application", mark: "FR" },
];
function routeLabel(row: Row) {
  const value = row.definition ?? row;
  if (/^ucas-\d+-standard$/.test(value.key)) return ["Most undergraduate courses", "Standard January deadline"];
  if (/^ucas-\d+-early$/.test(value.key)) return ["Oxford, Cambridge or an October-deadline course", "Includes most medicine, dentistry and veterinary courses"];
  return [value.name, value.applicability];
}
export function templateScope(definition: Row, applicantCountry?: string): Row {
  return { cycle: definition.cycle, country: definition.country, applicantCategory: definition.applicantCategory, program: definition.program, round: definition.round, ...(applicantCountry ? { applicantCountry } : {}) };
}
export function StudentBoardTemplates({ api, studentId, student, canSaveProfile = false, onProfileSaved, onClose, onCreated }: { api: Api; studentId: string; student?: Row; canSaveProfile?: boolean; onProfileSaved?: (student: Row) => void; onClose: () => void; onCreated: (id: string) => void }) {
  const guide = useRef<HTMLElement>(null);
  const [items, setItems] = useState<Row[]>([]), [path, setPath] = useState(""), [selectedState, setSelected] = useState<Row | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [name, setName] = useState(""), [rename, setRename] = useState(false), [applicantCountry, setApplicantCountry] = useState(""), [key, setKey] = useState(() => crypto.randomUUID());
  const [transientProfile, setTransientProfile] = useState<PlanningProfile | null>(null), [schoolYear, setSchoolYear] = useState(() => String(currentAcademicYear())), [graduation, setGraduation] = useState(""), [entryYear, setEntryYear] = useState(""), [askGraduation, setAskGraduation] = useState(false), [editSchoolYear, setEditSchoolYear] = useState(false);
  const earliestUpcomingEntry = Math.max(2027, currentAcademicYear() + 1);
  const savedIdentity = `${studentId}:${planningProfileKey(student?.planningProfile)}`;
  useEffect(() => { setTransientProfile(null); setAskGraduation(false); setEditSchoolYear(false); setGraduation(""); setEntryYear(""); setSchoolYear(String(student?.planningProfile?.academicYear ?? currentAcademicYear())); }, [savedIdentity]);
  // Only use explicitly shared profile facts. Do not infer nationality or years from names/emails.
  const profile: PlanningProfile = transientProfile ?? student?.planningProfile ?? {}, resolved = applicationCycle(profile), cycle = resolved.cycle;
  const knownGradeWithoutYear = profile.currentGrade !== undefined && Number.isInteger(profile.currentGrade) && profile.currentGrade >= 9 && profile.currentGrade <= 12 && profile.academicYear === undefined;
  const profileIdentity = `${studentId}:${planningProfileKey(profile)}`, requestGeneration = useRef(0);
  useEffect(() => {
    let cancelled = false; requestGeneration.current += 1;
    setItems([]); setSelected(null); setPath(""); setApplicantCountry(""); setName(""); setError(""); setKey(crypto.randomUUID());
    if (cycle === null || cycle < earliestUpcomingEntry) { setLoading(false); return; }
    setLoading(true);
    api(`planning/v1/templates?cycle=${cycle}`).then(data => { if (!cancelled) setItems((data.items ?? []).filter((row: Row) => (row.definition ?? row).cycle === cycle)); }).catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; requestGeneration.current += 1; };
  }, [api, profileIdentity, cycle, earliestUpcomingEntry]);
  async function applyProfile(next: PlanningProfile) {
    const check = applicationCycle(next);
    if (check.cycle === null) { setError(check.reason); return; }
    setError("");
    if (!canSaveProfile) { setTransientProfile(next); return; }
    setBusy(true);
    try { const data = await api(`clients/v1/clients/${studentId}`, "PATCH", { planningProfile: next }); setTransientProfile(data.item.planningProfile); onProfileSaved?.(data.item); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  function gradeProfile(grade: number): PlanningProfile { return { ...(profile.applicantCountry ? { applicantCountry: profile.applicantCountry } : {}), ...(profile.templateKey ? { templateKey: profile.templateKey } : {}), currentGrade: grade, academicYear: Number(schoolYear) }; }
  const selected = selectedState?.profileIdentity === profileIdentity ? selectedState : null;
  const routes = items.filter(row => (row.definition ?? row).key.startsWith(path) && !(row.definition ?? row).name.includes("(closed)"));
  const definition = selected?.definition;
  const needsCountry = definition?.applicantCountries?.length > 1 && !applicantCountry;
  const step = !path ? 1 : !selected ? 2 : needsCountry ? 2 : 3;
  useEffect(() => {
    if (loading) return;
    const heading = guide.current?.querySelector("h2");
    heading?.setAttribute("tabindex", "-1"); heading?.focus({ preventScroll: true });
    guide.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [loading, path, selected?.key, needsCountry]);
  async function select(row: Row) {
    const generation = ++requestGeneration.current;
    setLoading(true); setError("");
    try {
      const data = await api(`planning/v1/templates/${row.key}?version=${row.version}`), value = data.item.definition ?? data.item;
      if (generation !== requestGeneration.current || value.cycle !== cycle) return;
      setSelected({ ...data.item, definition: value, profileIdentity });
      const known = profile.applicantCountry;
      setApplicantCountry(value.applicantCountries?.includes(known) ? known : value.applicantCountries?.length === 1 ? value.applicantCountries[0] : "");
      const family = paths.find(item => value.key.startsWith(item.key));
      setName(`${student?.displayName ? `${student.displayName} · ` : ""}${family?.name ?? value.name} ${value.cycle}`.slice(0, 200));
      setRename(false); setKey(crypto.randomUUID());
    } catch (e) { if (generation === requestGeneration.current) setError(errorMessage(e)); } finally { if (generation === requestGeneration.current) setLoading(false); }
  }
  function choosePath(value: string) {
    setPath(value); setSelected(null); setError("");
    const matches = items.filter(row => (row.definition ?? row).key.startsWith(value) && !(row.definition ?? row).name.includes("(closed)"));
    const known = matches.find(row => row.key === profile.templateKey);
    if (known || matches.length === 1) void select(known ?? matches[0]);
  }
  function back() { setError(""); if (selected && routes.length > 1) setSelected(null); else if (path) { setPath(""); setSelected(null); } else onClose(); }
  async function create() {
    if (!definition || definition.cycle !== cycle || needsCountry || busy || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const data = await api(`planning/v1/templates/${definition.key}/instantiate`, "POST", { studentId, version: definition.version, name: name.trim(), idempotencyKey: key, applicabilityConfirmed: true, applicability: templateScope(definition, applicantCountry), sharing: "student" }, key);
      onCreated(data.item.id);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <section ref={guide} className="planning-guide" aria-label="Create an application plan">
    <div className="planning-guide-top"><button disabled={loading || busy} onClick={back}><ArrowLeft size={16} />{path ? "Back" : "All boards"}</button><span className="planning-step-label">{step === 1 ? "Choose your path" : step === 2 ? "Make it yours" : "Your plan"}</span><button disabled={busy} onClick={onClose}>Close</button></div>
    <div className="planning-step-track" aria-label={`Step ${step} of 3`}>{[1, 2, 3].map(value => <span key={value} className={value <= step ? "is-complete" : ""} />)}</div>
    <Notice error={error} />
    {cycle === null ? <div className="planning-guide-step"><span className="planning-eyebrow"><GraduationCap size={16} /> A quick school detail</span><h2>{askGraduation ? "When do you expect to graduate?" : knownGradeWithoutYear ? "Which school year is this grade for?" : "What grade are you in?"}</h2><p className="planning-guide-description">{resolved.reason} We’ll use this to choose your application dates.</p>{!askGraduation ? <><p className="crm-helper">{schoolYear}–{String(Number(schoolYear) + 1).slice(-2)} school year <button disabled={busy} onClick={() => setEditSchoolYear(!editSchoolYear)}>{editSchoolYear ? "Done" : "Change school year"}</button></p>{editSchoolYear && <label>School year starting in September<input type="number" min={2000} max={2199} value={schoolYear} disabled={busy} onChange={event => setSchoolYear(event.target.value)} /></label>}<div className="planning-path-grid">{(knownGradeWithoutYear ? [profile.currentGrade!] : [9, 10, 11, 12]).map(grade => <button className="planning-choice" key={grade} disabled={busy || !schoolYear} onClick={() => void applyProfile(gradeProfile(grade))}><strong>{knownGradeWithoutYear ? `Use ${schoolYear}–${String(Number(schoolYear) + 1).slice(-2)} for Grade ${grade}` : `Grade ${grade}`}</strong><span>University entry {Number(schoolYear) + 13 - grade}</span></button>)}</div><button disabled={busy} onClick={() => setAskGraduation(true)}>I know my graduation year / another school system</button></> : <form onSubmit={event => { event.preventDefault(); void applyProfile({ graduationYear: Number(graduation) }); }}><label>Expected graduation year<input type="number" min={2000} max={2200} required value={graduation} disabled={busy} onChange={event => setGraduation(event.target.value)} /></label><div className="form-actions"><button className="primary" disabled={busy || !graduation} type="submit">{busy ? "Saving…" : "Continue"}</button><button type="button" disabled={busy} onClick={() => setAskGraduation(false)}>Choose grade instead</button></div></form>}<p className="planning-guide-footnote">{canSaveProfile ? "These education details will be saved to the student record." : "This choice is used for this plan. Your tutor can save education details to your student record."}</p></div>
    : cycle < earliestUpcomingEntry ? <div className="planning-guide-step"><span className="planning-eyebrow"><GraduationCap size={16} /> Confirm your next step</span><h2>When do you expect to start university?</h2><p className="planning-guide-description">Your education details show graduation or entry in {cycle}. If you are taking a gap year, tell us your expected university entry year.</p><form onSubmit={event => { event.preventDefault(); void applyProfile({ ...profile, entryCycle: Number(entryYear) }); }}><label>Expected university entry year<input type="number" min={earliestUpcomingEntry} max={2200} required value={entryYear} disabled={busy} onChange={event => setEntryYear(event.target.value)} /></label><div className="form-actions"><button className="primary" disabled={busy || !entryYear} type="submit">{busy ? "Saving…" : "Continue"}</button></div></form><p className="planning-guide-footnote">{canSaveProfile ? "Your expected entry year will be saved to the student record." : "This choice is used for this plan. Your tutor can save it to your student record."}</p></div>
    : loading ? <Empty>Preparing your planning space…</Empty> : <div key={`${path}:${selected?.key ?? "choose"}:${needsCountry}`} className="planning-guide-step">
      {!path ? <><span className="planning-eyebrow"><Sparkles size={16} /> Let’s make a plan</span><h2>Where would you like to apply?</h2><p className="planning-guide-description">Pick a path. We’ll organize the next steps for {student?.displayName ?? "you"}.</p><div className="planning-path-grid">{paths.map(item => <button key={item.key} className="planning-choice" disabled={!items.some(row => (row.definition ?? row).key.startsWith(item.key))} onClick={() => choosePath(item.key)}><span className="planning-path-mark">{item.mark}</span><strong>{item.name}</strong><span>{item.detail}</span><ArrowRight className="planning-choice-arrow" size={18} /></button>)}{items.filter(row => !paths.some(item => row.key.startsWith(item.key))).map(row => <button className="planning-choice" key={row.key} onClick={() => { setPath(row.key); void select(row); }}><GraduationCap /><strong>{row.name}</strong><span>Custom application plan</span></button>)}</div><p className="planning-guide-footnote">Entry {cycle} · You can create more than one plan.</p></>
      : !selected ? <><span className="planning-eyebrow">{paths.find(item => item.key === path)?.name ?? "Application plan"}</span><h2>Which route fits your application?</h2><p className="planning-guide-description">This helps us put the right deadlines on your board.</p><div className="planning-route-list">{routes.map(row => { const [title, detail] = routeLabel(row); return <button className="planning-choice" key={row.key} onClick={() => void select(row)}><strong>{title}</strong><span>{detail}</span><ArrowRight className="planning-choice-arrow" size={18} /></button>; })}</div>{!routes.length && <Empty>No current template for this path. You can create a blank board instead.</Empty>}</>
      : needsCountry ? <><h2>Which applicant procedure are you using?</h2><p className="planning-guide-description">Choose the country that manages your application.</p><div className="planning-route-list">{definition.applicantCountries.map((country: string) => <button className="planning-choice" key={country} onClick={() => setApplicantCountry(country)}><strong>{new Intl.DisplayNames(undefined, { type: "region" }).of(country)}</strong><ArrowRight size={18} /></button>)}</div></>
      : <><span className="planning-eyebrow"><Check size={16} /> Ready when you are</span><h2>Your next steps, in one place.</h2><p className="planning-guide-description">{definition.name}{applicantCountry ? ` · ${new Intl.DisplayNames(undefined, { type: "region" }).of(applicantCountry)} procedure` : ""}</p><div className="planning-preview"><div className="planning-preview-header">{rename ? <label>Plan name<input autoFocus disabled={busy} required maxLength={200} value={name} onChange={e => { setName(e.target.value); setKey(crypto.randomUUID()); }} /></label> : <strong>{name}</strong>}<button disabled={busy} onClick={() => setRename(!rename)}>{rename ? "Done" : "Rename"}</button></div><ul>{definition.cards.map((card: Row) => <li key={card.key}><span className="planning-preview-check"><Check size={14} /></span><div><strong>{card.title}</strong>{card.deadline && <small>{card.deadline.dueAt ? `${card.deadline.status === "verified" ? "Official date" : "Suggested target — confirm"}: ${deadlineTime(card.deadline)} (${card.deadline.timeZone})` : "Add the date after checking your chosen institution"}</small>}</div></li>)}</ul></div><details className="planning-procedure"><summary>Procedure & official sources</summary><p>{definition.applicability}</p>{definition.sourceUrls?.map((url: string) => publicLink(url) && <a key={url} href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname} ↗</a>)}</details><p className="planning-guide-footnote">Creating this plan confirms the procedure above. Suggested targets help you prepare. Confirm each institution’s actual dates and requirements. Shared with your tutor.</p><button className="primary planning-create" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? "Creating your plan…" : "Create my plan"}<ArrowRight size={18} /></button></>}
    </div>}
  </section>;
}
