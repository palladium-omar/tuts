import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, GraduationCap, Sparkles } from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Notice } from "../components/shared";
import { deadlineTime, publicLink } from "./student-board-card";

const paths = [
  { key: "ucas", name: "UCAS", detail: "Apply to universities in the UK", mark: "UK" },
  { key: "common-app", name: "Common App", detail: "Build your US college applications", mark: "US" },
  { key: "bocconi", name: "Bocconi", detail: "Plan your application to Bocconi", mark: "IT" },
  { key: "campus-france", name: "Campus France", detail: "Prepare your Études en France application", mark: "FR" },
];
function routeLabel(row: Row) {
  const value = row.definition ?? row;
  if (value.key === "ucas-2027-standard") return ["Most undergraduate courses", "Standard January deadline"];
  if (value.key === "ucas-2027-early") return ["Oxford, Cambridge or an October-deadline course", "Includes most medicine, dentistry and veterinary courses"];
  return [value.name, value.applicability];
}
export function templateScope(definition: Row, applicantCountry?: string): Row {
  return { cycle: definition.cycle, country: definition.country, applicantCategory: definition.applicantCategory, program: definition.program, round: definition.round, ...(applicantCountry ? { applicantCountry } : {}) };
}
export function StudentBoardTemplates({ api, studentId, student, onClose, onCreated }: { api: Api; studentId: string; student?: Row; onClose: () => void; onCreated: (id: string) => void }) {
  const guide = useRef<HTMLElement>(null);
  const [items, setItems] = useState<Row[]>([]), [path, setPath] = useState(""), [selected, setSelected] = useState<Row | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [name, setName] = useState(""), [rename, setRename] = useState(false), [applicantCountry, setApplicantCountry] = useState(""), [key, setKey] = useState(() => crypto.randomUUID());
  // Only use explicitly shared profile facts. Do not infer nationality from names/emails.
  const profile = student?.planningProfile ?? {}, cycle = Number(profile.entryCycle) || 2027;
  useEffect(() => { let cancelled = false; api(`planning/v1/templates?cycle=${cycle}`).then(data => { if (!cancelled) setItems(data.items ?? []); }).catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [api, cycle]);
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
    setLoading(true); setError("");
    try {
      const data = await api(`planning/v1/templates/${row.key}?version=${row.version}`), value = data.item.definition ?? data.item;
      setSelected({ ...data.item, definition: value });
      const known = profile.applicantCountry;
      setApplicantCountry(value.applicantCountries?.includes(known) ? known : value.applicantCountries?.length === 1 ? value.applicantCountries[0] : "");
      const family = paths.find(item => value.key.startsWith(item.key));
      setName(`${student?.displayName ? `${student.displayName} · ` : ""}${family?.name ?? value.name} ${value.cycle}`.slice(0, 200));
      setRename(false); setKey(crypto.randomUUID());
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }
  function choosePath(value: string) {
    setPath(value); setSelected(null); setError("");
    const matches = items.filter(row => (row.definition ?? row).key.startsWith(value) && !(row.definition ?? row).name.includes("(closed)"));
    const known = matches.find(row => row.key === profile.templateKey);
    if (known || matches.length === 1) void select(known ?? matches[0]);
  }
  function back() { setError(""); if (selected && routes.length > 1) setSelected(null); else if (path) { setPath(""); setSelected(null); } else onClose(); }
  async function create() {
    if (!definition || needsCountry || busy || !name.trim()) return;
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
    {loading ? <Empty>Preparing your planning space…</Empty> : <div key={`${path}:${selected?.key ?? "choose"}:${needsCountry}`} className="planning-guide-step">
      {!path ? <><span className="planning-eyebrow"><Sparkles size={16} /> Let’s make a plan</span><h2>Where would you like to apply?</h2><p className="planning-guide-description">Pick a path. We’ll organize the next steps for {student?.displayName ?? "you"}.</p><div className="planning-path-grid">{paths.map(item => <button key={item.key} className="planning-choice" disabled={!items.some(row => (row.definition ?? row).key.startsWith(item.key))} onClick={() => choosePath(item.key)}><span className="planning-path-mark">{item.mark}</span><strong>{item.name}</strong><span>{item.detail}</span><ArrowRight className="planning-choice-arrow" size={18} /></button>)}{items.filter(row => !paths.some(item => row.key.startsWith(item.key))).map(row => <button className="planning-choice" key={row.key} onClick={() => { setPath(row.key); void select(row); }}><GraduationCap /><strong>{row.name}</strong><span>Custom application plan</span></button>)}</div><p className="planning-guide-footnote">Entry {cycle} · You can create more than one plan.</p></>
      : !selected ? <><span className="planning-eyebrow">{paths.find(item => item.key === path)?.name ?? "Application plan"}</span><h2>Which route fits your application?</h2><p className="planning-guide-description">This helps us put the right deadlines on your board.</p><div className="planning-route-list">{routes.map(row => { const [title, detail] = routeLabel(row); return <button className="planning-choice" key={row.key} onClick={() => void select(row)}><strong>{title}</strong><span>{detail}</span><ArrowRight className="planning-choice-arrow" size={18} /></button>; })}</div>{!routes.length && <Empty>No current template for this path. You can create a blank board instead.</Empty>}</>
      : needsCountry ? <><h2>Which applicant procedure are you using?</h2><p className="planning-guide-description">Choose the country that manages your application.</p><div className="planning-route-list">{definition.applicantCountries.map((country: string) => <button className="planning-choice" key={country} onClick={() => setApplicantCountry(country)}><strong>{new Intl.DisplayNames(undefined, { type: "region" }).of(country)}</strong><ArrowRight size={18} /></button>)}</div></>
      : <><span className="planning-eyebrow"><Check size={16} /> Ready when you are</span><h2>Your next steps, in one place.</h2><p className="planning-guide-description">{definition.name}{applicantCountry ? ` · ${new Intl.DisplayNames(undefined, { type: "region" }).of(applicantCountry)} procedure` : ""}</p><div className="planning-preview"><div className="planning-preview-header">{rename ? <label>Plan name<input autoFocus disabled={busy} required maxLength={200} value={name} onChange={e => { setName(e.target.value); setKey(crypto.randomUUID()); }} /></label> : <strong>{name}</strong>}<button disabled={busy} onClick={() => setRename(!rename)}>{rename ? "Done" : "Rename"}</button></div><ul>{definition.cards.map((card: Row) => <li key={card.key}><span className="planning-preview-check"><Check size={14} /></span><div><strong>{card.title}</strong>{card.deadline && <small>{card.deadline.dueAt ? deadlineTime(card.deadline) : "Add the date after checking your chosen institution"}</small>}</div></li>)}</ul></div><details className="planning-procedure"><summary>Procedure & official sources</summary><p>{definition.applicability}</p>{definition.sourceUrls?.map((url: string) => publicLink(url) && <a key={url} href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname} ↗</a>)}</details><p className="planning-guide-footnote">Creating this plan confirms the procedure above. College-specific dates stay unset until you confirm them. Shared with your tutor.</p><button className="primary planning-create" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? "Creating your plan…" : "Create my plan"}<ArrowRight size={18} /></button></>}
    </div>}
  </section>;
}
