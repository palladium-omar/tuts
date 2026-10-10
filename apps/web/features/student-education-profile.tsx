import { useEffect, useState } from "react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Notice } from "../components/shared";
import { applicationCycle, currentAcademicYear, planningProfileKey, type PlanningProfile } from "../lib/application-cycle";

export function StudentEducationProfile({ api, student, canWrite, onChanged, onBusyChange }: { api: Api; student: Row; canWrite: boolean; onChanged: (student: Row) => void; onBusyChange?: (busy: boolean) => void }) {
  const profile = student.planningProfile as PlanningProfile | undefined, resolved = applicationCycle(profile);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [grade, setGrade] = useState(""), [schoolYear, setSchoolYear] = useState(""), [graduation, setGraduation] = useState(""), [entry, setEntry] = useState("");
  const identity = `${student.id}:${planningProfileKey(profile)}`;
  useEffect(() => { setEditing(false); setError(""); }, [identity]);
  function edit() {
    setGrade(profile?.currentGrade === undefined ? "" : String(profile.currentGrade));
    setSchoolYear(String(profile?.academicYear ?? currentAcademicYear()));
    setGraduation(profile?.graduationYear === undefined ? "" : String(profile.graduationYear));
    setEntry(profile?.entryCycle === undefined ? "" : String(profile.entryCycle));
    setError(""); setEditing(true);
  }
  function updateGrade(value: string) { setGrade(value); if (value && schoolYear) setGraduation(String(Number(schoolYear) + 13 - Number(value))); }
  function updateSchoolYear(value: string) { setSchoolYear(value); if (grade && value) setGraduation(String(Number(value) + 13 - Number(grade))); }
  async function save(clear = false) {
    if (!canWrite || busy) return;
    const next: PlanningProfile | null = clear ? null : {
      ...(profile?.applicantCountry ? { applicantCountry: profile.applicantCountry } : {}),
      ...(profile?.templateKey ? { templateKey: profile.templateKey } : {}),
      ...(grade ? { currentGrade: Number(grade), academicYear: Number(schoolYear) } : {}),
      ...(graduation ? { graduationYear: Number(graduation) } : {}),
      ...(entry ? { entryCycle: Number(entry) } : {}),
    };
    if (next && applicationCycle(next).cycle === null) { setError(applicationCycle(next).reason ?? "Confirm your education details."); return; }
    setBusy(true); onBusyChange?.(true); setError("");
    try { const data = await api(`clients/v1/clients/${student.id}`, "PATCH", { planningProfile: next }); onChanged(data.item); setEditing(false); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  return <section className="tracker-detail-item" aria-label="Education and application planning">
    <h3>Education & application planning</h3><Notice error={error} />
    {!editing ? <>{resolved.cycle === null ? <p className="crm-helper">Add the grade and school year, or expected graduation, to choose the right application dates.</p> : <p>{profile?.currentGrade && <>Grade {profile.currentGrade} · </>}{profile?.academicYear && <>{profile.academicYear}–{String(profile.academicYear + 1).slice(-2)} · </>}Graduation {resolved.graduationYear ?? "to confirm"} · University entry {resolved.cycle}</p>}{canWrite && <button onClick={edit}>Edit education details</button>}</> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="form-grid">
        <label>Current grade<select value={grade} disabled={busy} onChange={event => updateGrade(event.target.value)}><option value="">Other school system / grade unknown</option>{[9, 10, 11, 12].map(value => <option key={value} value={value}>Grade {value}</option>)}</select></label>
        <label>School year starting in September<input type="number" min={2000} max={2199} required={Boolean(grade)} disabled={busy || !grade} value={schoolYear} onChange={event => updateSchoolYear(event.target.value)} /><small>2026 means the 2026–27 school year.</small></label>
        <label>Expected graduation year<input type="number" min={2000} max={2200} disabled={busy} value={graduation} onChange={event => setGraduation(event.target.value)} /></label>
        <label>University entry year, if different<input type="number" min={2000} max={2200} disabled={busy} value={entry} onChange={event => setEntry(event.target.value)} /><small>Leave empty for entry in the graduation year; set it for a gap year.</small></label>
      </div><div className="form-actions"><button className="primary" disabled={busy} type="submit">{busy ? "Saving…" : "Save education details"}</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>{profile && <button type="button" disabled={busy} onClick={() => void save(true)}>Clear education details</button>}</div>
    </form>}
  </section>;
}
