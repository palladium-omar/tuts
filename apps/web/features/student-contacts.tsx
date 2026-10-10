import { useEffect, useState, type FormEvent } from "react";
import { Plus, Pencil, X } from "lucide-react";
import { errorMessage, type Api, type Row } from "../lib/api";
import { Empty, Notice } from "../components/shared";
import "./student-contacts.css";

type Address = { id?: string; value: string; label: string; isPrimary: boolean };
type Contact = { id?: string; displayName: string; relationship: string; isPrimary: boolean; emails: Address[]; phones: Address[] };
const blank = (): Contact => ({ displayName: "", relationship: "parent", isPrimary: false, emails: [{ value: "", label: "", isPrimary: true }], phones: [] });
const relationshipLabels: Record<string, string> = { student: "Student", parent: "Parent", guardian: "Guardian", sponsor: "Sponsor / payer", self: "Self", other: "Other" };

export function StudentContacts({ api, student, canWrite, onChanged, onBusyChange }: { api: Api; student: Row; canWrite: boolean; onChanged: () => void | Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]), [draft, setDraft] = useState<Contact | null>(null), [removing, setRemoving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setContacts([]); setDraft(null); setRemoving(null);
    api(`clients/v1/clients/${student.id}/contacts`).then((data) => { if (!cancelled) setContacts(data.items ?? []); }).catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, student.id, revision]);
  function changeAddresses(kind: "emails" | "phones", at: number, patch: Partial<Address>) {
    setDraft((current) => current && ({ ...current, [kind]: current[kind].map((address, index) => index === at ? { ...address, ...patch } : patch.isPrimary ? { ...address, isPrimary: false } : address) }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !canWrite) return;
    setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try {
      const clean = (addresses: Address[]) => addresses.filter((a) => a.value.trim()).map((a) => ({ value: a.value.trim(), label: a.label.trim() || undefined, isPrimary: a.isPrimary }));
      await api(`clients/v1/clients/${student.id}/contacts${draft.id ? `/${draft.id}` : ""}`, draft.id ? "PATCH" : "POST", { displayName: draft.displayName.trim(), relationship: draft.relationship, isPrimary: draft.isPrimary, emails: clean(draft.emails), phones: clean(draft.phones) });
      setDraft(null); setRevision((n) => n + 1); setMessage("Related contact saved."); await onChanged();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); onBusyChange?.(false); }
  }
  async function detach(contactId: string) {
    if (!canWrite) return;
    setBusy(true); onBusyChange?.(true); setError("");
    try { await api(`clients/v1/clients/${student.id}/contacts/${contactId}`, "DELETE"); setRemoving(null); setRevision((n) => n + 1); setMessage("Contact removed from this record."); await onChanged(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); onBusyChange?.(false); }
  }
  return <section aria-label={`Contacts for ${student.displayName}`}>
    <p className="crm-helper">Add student, family and payer contacts with their own email addresses and phone numbers. A family email can be shared by several students.</p>
    <Notice error={error} message={message} />
    {loading ? <Empty>Loading related contacts…</Empty> : <>
      <div className="student-contact-list">
        {contacts.map((contact) => <article className="student-contact-card" key={contact.id}>
          <div className="student-contact-heading"><div><h3>{contact.displayName}</h3><span className="tag">{relationshipLabels[contact.relationship] ?? contact.relationship}</span>{contact.isPrimary && <span className="tag">Primary contact</span>}</div>
            {canWrite && <div className="student-contact-actions"><button disabled={busy} onClick={() => { setDraft({ ...contact, emails: contact.emails.map((a) => ({ ...a, label: a.label ?? "" })), phones: contact.phones.map((a) => ({ ...a, label: a.label ?? "" })) }); setRemoving(null); setError(""); setMessage(""); }}><Pencil size={14} /> Edit</button><button disabled={busy} onClick={() => { setRemoving(contact.id!); setDraft(null); }}>Remove link</button></div>}
          </div>
          {(["emails", "phones"] as const).map((kind) => contact[kind].map((address, index) => <div className="student-contact-address" key={address.id ?? `${kind}-${index}`}><small>{kind === "emails" ? "Email" : "Phone"}</small><span>{address.value}</span>{address.label && <small>{address.label}</small>}{address.isPrimary && <span className="tag">Primary {kind === "emails" ? "email" : "phone"}</span>}</div>))}
          {!contact.emails.length && !contact.phones.length && <p className="crm-helper">No email or phone added.</p>}
          {removing === contact.id && <div className="student-contact-warning"><p>Remove {contact.displayName} from this record? Their other student relationships and shared contact details will be preserved.</p><div className="student-contact-actions"><button disabled={busy} onClick={() => setRemoving(null)}>Cancel</button><button disabled={busy} onClick={() => void detach(contact.id!)}>{busy ? "Removing…" : "Confirm removal"}</button></div></div>}
        </article>)}
      </div>
      {!contacts.length && !error && <Empty>No related contacts yet.</Empty>}
      {canWrite && !draft && <button onClick={() => { setDraft(blank()); setError(""); setMessage(""); }}><Plus size={15} /> Add related contact</button>}
    </>}
    {draft && <form className="student-contact-form" onSubmit={save}>
      <h3>{draft.id ? "Edit related contact" : "New related contact"}</h3>
      {draft.id && <p className="student-contact-warning">This contact may be shared with other students. Changes to their name, email addresses and phone numbers apply to all their relationships.</p>}
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid"><label>Contact name<input required maxLength={160} value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} /></label><label>Relationship<select value={draft.relationship} onChange={(e) => setDraft({ ...draft, relationship: e.target.value })}>{Object.entries(relationshipLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
        <label className="crm-check"><input type="checkbox" checked={draft.isPrimary} onChange={(e) => setDraft({ ...draft, isPrimary: e.target.checked })} />Primary contact for this record</label>
        {(["emails", "phones"] as const).map((kind) => <div key={kind}><h4>{kind === "emails" ? "Email addresses" : "Phone numbers"}</h4>{draft[kind].map((address, at) => <div className="student-address-fields" key={at}><label>Label<input maxLength={80} placeholder="Home, work…" value={address.label} onChange={(e) => changeAddresses(kind, at, { label: e.target.value })} /></label><label>{kind === "emails" ? "Email" : "Phone"}<input required type={kind === "emails" ? "email" : "tel"} maxLength={kind === "emails" ? 320 : 40} value={address.value} onChange={(e) => changeAddresses(kind, at, { value: e.target.value })} /></label><div className="student-address-controls"><label className="crm-check"><input aria-label={`Primary ${kind === "emails" ? "email" : "phone"} ${at + 1}`} type="checkbox" checked={address.isPrimary} onChange={(e) => changeAddresses(kind, at, { isPrimary: e.target.checked })} />Primary</label></div><button type="button" aria-label={`Remove ${kind === "emails" ? "email" : "phone"} ${at + 1}`} onClick={() => setDraft({ ...draft, [kind]: draft[kind].filter((_, i) => i !== at) })}><X size={15} /></button></div>)}<button type="button" disabled={draft[kind].length >= 20} onClick={() => setDraft({ ...draft, [kind]: [...draft[kind], { value: "", label: "", isPrimary: draft[kind].length === 0 }] })}><Plus size={14} /> Add {kind === "emails" ? "email" : "phone"}</button></div>)}
      </fieldset>
      <div className="form-actions"><button type="button" disabled={busy} onClick={() => setDraft(null)}>Cancel contact edit</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save related contact"}</button></div>
    </form>}
  </section>;
}
