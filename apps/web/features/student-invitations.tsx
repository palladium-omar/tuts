import { useEffect, useState } from "react";
import { hasPermission } from "@palladium/contracts";
import { errorMessage, type Api, type Business, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";

type Recipient = { studentId: string; contactId: string; emailAddressId: string; relationship: "student" | "guardian"; name: string; email: string };
type Invitation = { id: string; studentId: string; recipientEmail: string; status: string; deliveryError?: string | null; expiresAt: string; relationship: string };
type Grant = { id: string; studentId: string; relationship: string; createdAt: string };
const statuses: Record<string, string> = { queued: "Delivery pending", delivery_failed: "Delivery failed", sent: "Accepted by email provider", accepted: "Portal access accepted", revoked: "Revoked", expired: "Expired" };
const recipientKey = (recipient: Recipient) => `${recipient.studentId}:${recipient.contactId}:${recipient.emailAddressId}:${recipient.relationship}`;

export function StudentInvitations({ api, business, students, onClose }: { api: Api; business: Business; students: Row[]; onClose: () => void }) {
  const canManage = hasPermission(business, "platform.invites.manage");
  const [recipients, setRecipients] = useState<Record<string, Recipient[]>>({}), [invitations, setInvitations] = useState<Invitation[]>([]), [selected, setSelected] = useState<Map<string, Recipient>>(new Map()), [manualUrls, setManualUrls] = useState<Record<string, string>>({});
  const [sender, setSender] = useState<Row | null>(null), [senderError, setSenderError] = useState(""), [offset, setOffset] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [grants, setGrants] = useState<Grant[]>([]), [revokeGrant, setRevokeGrant] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const page = students.slice(offset, offset + 20), studentKey = students.map((student) => student.id).join(",");
  useEffect(() => { let cancelled = false; api(`platform/v1/portal/sender-status?businessId=${encodeURIComponent(business.id)}`).then((data) => { if (!cancelled) setSender(data.item); }).catch((e) => { if (!cancelled) setSenderError(errorMessage(e)); }); return () => { cancelled = true; }; }, [api, business.id]);
  useEffect(() => {
    let cancelled = false; setLoading(true); setError("");
    async function load() {
      for (let at = 0; at < page.length; at += 4) {
        const batch = await Promise.all(page.slice(at, at + 4).map(async (student) => {
          const results = await Promise.all([api(`clients/v1/clients/${student.id}/contacts`), api(`platform/v1/portal/invitations?businessId=${encodeURIComponent(business.id)}&studentId=${student.id}`), ...(canManage ? [api(`platform/v1/portal/access?businessId=${encodeURIComponent(business.id)}&studentId=${student.id}`)] : [])]);
          const addresses: Recipient[] = [];
          for (const contact of results[0].items ?? []) {
            const relationship = ["student", "self"].includes(contact.relationship) ? "student" : ["parent", "guardian"].includes(contact.relationship) ? "guardian" : null;
            if (!relationship) continue;
            for (const email of contact.emails ?? []) addresses.push({ studentId: student.id, contactId: contact.id, emailAddressId: email.id, relationship, name: contact.displayName, email: email.value });
          }
          return { studentId: student.id, addresses, invitations: results[1].items ?? [], grants: results[2]?.items ?? [] };
        }));
        if (cancelled) return;
        for (const result of batch) { setRecipients((current) => ({ ...current, [result.studentId]: result.addresses })); setInvitations((current) => [...current.filter((invitation) => invitation.studentId !== result.studentId), ...result.invitations]); setGrants((current) => [...current.filter((grant) => grant.studentId !== result.studentId), ...result.grants]); }
      }
    }
    load().catch((e) => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, business.id, studentKey, offset, revision, canManage]);
  function remember(result: Row) { const invitation = result.item as Invitation; setInvitations((current) => [...current.filter((item) => item.id !== invitation.id), invitation]); if (result.manualInviteUrl) setManualUrls((current) => ({ ...current, [invitation.id]: result.manualInviteUrl })); return invitation; }
  async function create() {
    if (!canManage || !confirmed || !selected.size) return;
    setBusy(true); setError(""); setMessage(""); let processed = 0;
    try {
      for (const [key, recipient] of selected) {
        remember(await api("platform/v1/portal/invitations", "POST", { businessId: business.id, studentId: recipient.studentId, contactId: recipient.contactId, emailAddressId: recipient.emailAddressId, relationship: recipient.relationship }));
        processed++; setSelected((current) => { const next = new Map(current); next.delete(key); return next; });
      }
      setMessage(`${processed} invitation${processed === 1 ? "" : "s"} processed. Review delivery status below.`); setConfirmed(false);
    } catch (e) { setError(`${processed} invitations processed before this request failed. Remaining recipients are still selected. ${errorMessage(e)}`); setConfirmed(false); } finally { setBusy(false); }
  }
  async function update(invitation: Invitation, revoke: boolean) {
    if (!canManage) return; setBusy(true); setError(""); setMessage("");
    try { const result = await api(`platform/v1/portal/invitations/${invitation.id}${revoke ? `?businessId=${encodeURIComponent(business.id)}` : "/resend"}`, revoke ? "DELETE" : "POST", revoke ? undefined : { businessId: business.id }); remember(result); if (revoke) setManualUrls((current) => { const next = { ...current }; delete next[invitation.id]; return next; }); setMessage(revoke ? "Invitation revoked." : "Invitation refreshed. Review its delivery status."); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function copy(id: string) { try { await navigator.clipboard.writeText(manualUrls[id]); setMessage("Invitation link copied. Share it only with the designated recipient."); } catch { setError("The link could not be copied automatically. Select and copy it from the field."); } }
  async function removeGrant(id: string) { if (!canManage) return; setBusy(true); setError(""); try { await api(`platform/v1/portal/access/${id}?businessId=${encodeURIComponent(business.id)}`, "DELETE"); setGrants((current) => current.filter((grant) => grant.id !== id)); setRevokeGrant(null); setRevision((n) => n + 1); setManualUrls({}); setMessage("Portal access revoked. Older pending invitations for this recipient and student were invalidated."); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <Modal title="Invite students and guardians to the portal" onClose={() => { if (!busy) onClose(); }}>
    <Notice error={error || senderError} message={message} />
    <p className="crm-helper">Select the stored student or guardian email addresses to invite. Access is limited to the linked student. The recipient must sign in using the invited email.</p>
    {sender ? <p className="student-contact-warning">{sender.available ? "Email delivery is configured. Provider acceptance will be shown separately from invitation acceptance." : "Email delivery is unavailable. Creating an invitation will show a failed or pending delivery status and provide a fresh manual invitation link."}</p> : <p className="crm-helper">Checking email delivery availability…</p>}
    <button disabled={busy || loading} onClick={() => setRevision((n) => n + 1)}>Refresh invitation and access status</button>
    {loading && <p role="status" className="crm-helper">Loading recipient addresses and invitation status…</p>}
    {page.map((student) => <section className="tracker-invite-student" key={student.id}><h3>{student.displayName}</h3>
      {recipients[student.id] === undefined ? <p className="crm-helper">Recipient addresses have not loaded.</p> : !recipients[student.id].length ? <p className="crm-helper">No student or guardian email is available. Add a student, parent or guardian contact with an email first.</p> : recipients[student.id].map((recipient) => {
        const key = recipientKey(recipient), active = invitations.find((invitation) => invitation.studentId === student.id && invitation.recipientEmail.toLowerCase() === recipient.email.toLowerCase() && ["queued", "sent", "accepted"].includes(invitation.status));
        return <label className="tracker-invite-recipient" key={key}><input type="checkbox" checked={selected.has(key)} disabled={busy || !canManage || Boolean(active)} onChange={(e) => { setSelected((current) => { const next = new Map(current); if (e.target.checked) next.set(key, recipient); else next.delete(key); return next; }); setConfirmed(false); }} /><span><strong>{recipient.name}</strong> · {recipient.relationship === "student" ? "Student" : "Guardian"}<small>{recipient.email}{active ? ` · ${statuses[active.status] ?? active.status}` : ""}</small></span></label>;
      })}
      {invitations.filter((invitation) => invitation.studentId === student.id).map((invitation) => <div className="tracker-detail-item" key={invitation.id}><strong>{invitation.recipientEmail}</strong><div className="tracker-status-line"><span className="tag">{statuses[invitation.status] ?? invitation.status}</span><small>Expires {new Date(invitation.expiresAt).toLocaleString()}</small></div>{invitation.deliveryError && <p className="crm-helper">{invitation.deliveryError === "sender_unavailable" ? "No email sender is configured." : "Email delivery failed."}</p>}{manualUrls[invitation.id] && !["accepted", "revoked", "expired"].includes(invitation.status) && <div className="tracker-manual-invite"><label>Fresh manual invitation link<input readOnly aria-label={`Manual invitation link for ${invitation.recipientEmail}`} value={manualUrls[invitation.id]} onFocus={(e) => e.target.select()} /></label><button disabled={busy} onClick={() => void copy(invitation.id)}>Copy invitation link</button><p className="crm-helper">This private link is shown only when created or refreshed. It expires and can be accepted once.</p></div>}{canManage && <div className="tracker-actions">{!["accepted", "revoked"].includes(invitation.status) && <button disabled={busy} onClick={() => void update(invitation, false)}>Refresh and retry invitation</button>}{!["accepted", "revoked"].includes(invitation.status) && <button disabled={busy} onClick={() => void update(invitation, true)}>Revoke invitation</button>}</div>}</div>)}
      {grants.filter((grant) => grant.studentId === student.id).map((grant) => <div className="tracker-detail-item" key={grant.id}><strong>Active {grant.relationship === "guardian" ? "guardian" : "student"} portal access</strong><p className="crm-helper">Granted {new Date(grant.createdAt).toLocaleString()}</p>{revokeGrant === grant.id ? <div className="student-contact-warning"><p>Revoke this person's portal access to {student.displayName}? Older pending invitations for the same recipient and student will also be invalidated.</p><div className="tracker-actions"><button disabled={busy} onClick={() => setRevokeGrant(null)}>Cancel</button><button disabled={busy} onClick={() => void removeGrant(grant.id)}>Confirm access revocation</button></div></div> : <button disabled={busy} onClick={() => setRevokeGrant(grant.id)}>Revoke portal access</button>}</div>)}
    </section>)}
    {students.length > 20 && <div className="pagination"><span>Students {offset + 1}–{Math.min(offset + 20, students.length)} of {students.length}</span><button disabled={busy || loading || offset === 0} onClick={() => setOffset((n) => Math.max(0, n - 20))}>Previous students</button><button disabled={busy || loading || offset + 20 >= students.length} onClick={() => setOffset((n) => n + 20)}>Next students</button></div>}
    {canManage && <><div className="tracker-picker-count" role="status"><strong>{selected.size} recipient{selected.size === 1 ? "" : "s"} selected across reviewed pages</strong></div><label className="tracker-check"><input type="checkbox" checked={confirmed} disabled={busy || !selected.size} onChange={(e) => setConfirmed(e.target.checked)} />I reviewed these recipients and authorize creating and delivering their invitations.</label></>}
    <div className="form-actions"><button disabled={busy} onClick={onClose}>Done</button>{canManage && <button className="primary" disabled={busy || loading || !confirmed || !selected.size} onClick={() => void create()}>{busy ? "Processing invitations…" : `Confirm ${selected.size} invitation${selected.size === 1 ? "" : "s"}`}</button>}</div>
    {!students.length && <Empty>No newly added students need an invitation review.</Empty>}
  </Modal>;
}
