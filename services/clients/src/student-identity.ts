import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { emitEvent, assertStudentAccess } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { item, requireClient, updateContact, type ClientRow } from './contact-store.js';
import { remapStudentGroups } from "./groups-store.js";
import type { ContactPatch } from './schemas.js';
export const normalizeName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const normalizePhone = (value: string) => value.replace(/[^0-9+]/g, '');
export type AddressInput = {
    value: string;
    label?: string;
    isPrimary?: boolean;
};
export type RelatedContactInput = {
    contactId?: string;
    displayName?: string;
    relationship?: string;
    isPrimary?: boolean;
    emails?: AddressInput[];
    phones?: AddressInput[];
};
export async function requireStudent(tx: PoolClient, id: string) {
    const row = await requireClient(tx, id);
    if (row.kind !== 'student')
        throw new ConflictException('This operation requires a student');
    return row;
}
export async function syncLegacyContact(tx: PoolClient, businessId: string, row: ClientRow) {
    await tx.query(`INSERT INTO related_contacts(business_id,id,display_name) VALUES($1,$2,$3) ON CONFLICT(business_id,id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=now()`, [businessId, row.id, row.display_name]);
    if (row.kind === 'student')
        await tx.query(`INSERT INTO student_contacts(business_id,student_id,contact_id,relationship,is_primary) VALUES($1,$2,$2,'student',true) ON CONFLICT DO NOTHING`, [businessId, row.id]);
    for (const [kind, value] of [['email', row.email], ['phone', row.phone]] as const) {
        await tx.query('UPDATE contact_addresses SET is_primary=false WHERE contact_id=$1 AND kind=$2', [row.id, kind]);
        if (value)
            await tx.query(`INSERT INTO contact_addresses(business_id,id,contact_id,kind,value,normalized_value,is_primary) VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(business_id,contact_id,kind,normalized_value) DO UPDATE SET value=EXCLUDED.value,is_primary=true`, [businessId, randomUUID(), row.id, kind, value, kind === 'email' ? value.trim().toLowerCase() : normalizePhone(value)]);
    }
    const affected = await tx.query<{
        id: string;
        revision: number;
    }>(`UPDATE clients SET revision=revision+1,updated_at=now() WHERE id<>$1 AND id IN (SELECT student_id FROM student_contacts WHERE contact_id=$1) RETURNING id,revision`, [row.id]);
    for (const linked of affected.rows)
        await emitEvent(tx, {
            type: 'clients.contacts-updated.v1', producer: 'clients', businessId, data: {
                clientId: linked.id, revision: linked.revision
            }
        });
}
export async function listRelatedContacts(tx: PoolClient, studentId: string) {
    const rows = await tx.query<{
        id: string;
        display_name: string;
        relationship: string;
        is_primary: boolean;
    }>(`SELECT c.id,c.display_name,s.relationship,s.is_primary FROM student_contacts s JOIN related_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.student_id=$1 ORDER BY s.is_primary DESC,s.created_at,c.id LIMIT 100`, [studentId]);
    const addresses = await tx.query<{
        id: string;
        contact_id: string;
        kind: string;
        value: string;
        label: string;
        is_primary: boolean;
    }>(`SELECT a.* FROM contact_addresses a JOIN student_contacts s ON s.business_id=a.business_id AND s.contact_id=a.contact_id WHERE s.student_id=$1 ORDER BY a.is_primary DESC,a.created_at,a.id`, [studentId]);
    return rows.rows.map(row => ({
        id: row.id, displayName: row.display_name, relationship: row.relationship, isPrimary: row.is_primary, emails: addresses.rows.filter(a => a.contact_id === row.id && a.kind === 'email').map(addressItem), phones: addresses.rows.filter(a => a.contact_id === row.id && a.kind === 'phone').map(addressItem)
    }));
}
function addressItem(a: {
    id: string;
    value: string;
    label: string;
    is_primary: boolean;
}) {
    return {
        id: a.id, value: a.value, label: a.label, isPrimary: a.is_primary
    };
}
export async function saveRelatedContact(tx: PoolClient, ctx: RequestContext, studentId: string, input: RelatedContactInput, editingId?: string) {
    const student = await requireStudent(tx, studentId);
    assertStudentAccess(ctx, student.id);
    studentId = student.id;
    let id = editingId ?? input.contactId;
    if (editingId) {
        const linked = await tx.query('SELECT 1 FROM student_contacts WHERE student_id=$1 AND contact_id=$2', [studentId, editingId]);
        if (!linked.rowCount)
            throw new NotFoundException('Student contact was not found');
    }
    if (id) {
        const found = await tx.query('SELECT 1 FROM related_contacts WHERE id=$1', [id]);
        if (!found.rowCount)
            throw new NotFoundException('Related contact was not found');
    }
    else {
        if (!input.displayName)
            throw new ConflictException('A new contact requires a display name');
        const count = await tx.query<{
            count: string;
        }>('SELECT count(*) FROM student_contacts WHERE student_id=$1', [studentId]);
        if (Number(count.rows[0]!.count) >= 100)
            throw new ConflictException('At most 100 related contacts');
        id = randomUUID();
        await tx.query('INSERT INTO related_contacts(business_id,id,display_name) VALUES($1,$2,$3)', [ctx.businessId, id, input.displayName]);
    }
    if (id && ctx.accessScope === 'students') {
        const related = await tx.query<{
            student_id: string;
        }>('SELECT student_id FROM student_contacts WHERE contact_id=$1', [id]);
        for (const link of related.rows)
            assertStudentAccess(ctx, link.student_id);
    }
    const countLinks = await tx.query<{
        count: string;
    }>('SELECT count(*) FROM student_contacts WHERE student_id=$1', [studentId]);
    const alreadyLinked = await tx.query('SELECT 1 FROM student_contacts WHERE student_id=$1 AND contact_id=$2', [studentId, id]);
    if (!alreadyLinked.rowCount && Number(countLinks.rows[0]!.count) >= 100)
        throw new ConflictException('At most 100 related contacts');
    if (input.displayName)
        await tx.query('UPDATE related_contacts SET display_name=$2,updated_at=now() WHERE id=$1', [id, input.displayName]);
    if (input.isPrimary)
        await tx.query('UPDATE student_contacts SET is_primary=false WHERE student_id=$1', [studentId]);
    await tx.query(`INSERT INTO student_contacts(business_id,student_id,contact_id,relationship,is_primary) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_id,student_id,contact_id) DO UPDATE SET relationship=COALESCE($6,student_contacts.relationship),is_primary=COALESCE($7,student_contacts.is_primary)`, [ctx.businessId, studentId, id, input.relationship ?? 'other', input.isPrimary ?? false, input.relationship ?? null, input.isPrimary ?? null]);
    for (const [kind, values] of [['email', input.emails], ['phone', input.phones]] as const) {
        if (values === undefined)
            continue;
        // Replacing this contact's addresses is explicit and applies to all linked students.
        await tx.query('DELETE FROM contact_addresses WHERE contact_id=$1 AND kind=$2', [id, kind]);
        const seen = new Set<string>();
        for (const [index, a] of values.entries()) {
            const normalized = kind === 'email' ? a.value.trim().toLowerCase() : normalizePhone(a.value);
            if (seen.has(normalized))
                continue;
            seen.add(normalized);
            await tx.query('INSERT INTO contact_addresses(business_id,id,contact_id,kind,value,normalized_value,label,is_primary) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [ctx.businessId, randomUUID(), id, kind, kind === 'email' ? normalized : a.value, normalized, a.label ?? 'personal', values.some(v => v.isPrimary) ? Boolean(a.isPrimary) : index === 0]);
        }
    }
    // Legacy records remain compatible when their own related contact is edited.
    const legacy = await tx.query<ClientRow>('SELECT * FROM clients WHERE id=$1 AND merged_into IS NULL', [id]);
    if (legacy.rows[0]) {
        const patch: ContactPatch = {};
        if (input.displayName)
            patch.displayName = input.displayName;
        if (input.emails !== undefined)
            patch.email = (input.emails.find(a => a.isPrimary) ?? input.emails[0])?.value ?? null;
        if (input.phones !== undefined)
            patch.phone = (input.phones.find(a => a.isPrimary) ?? input.phones[0])?.value ?? null;
        if (Object.keys(patch).length)
            await updateContact(tx, ctx.businessId, id, patch, ctx.requestId, false, false);
    }
    const revision = await tx.query<{
        id: string;
        revision: number;
    }>('UPDATE clients SET revision=revision+1,updated_at=now() WHERE id IN (SELECT student_id FROM student_contacts WHERE contact_id=$1) RETURNING id,revision', [id]);
    for (const affected of revision.rows)
        await emitEvent(tx, {
            type: 'clients.contacts-updated.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                clientId: affected.id, revision: affected.revision
            }
        });
    return (await listRelatedContacts(tx, studentId)).find(c => c.id === id)!;
}
const mergeFields = ['photo', 'firstName', 'lastName', 'displayName', 'notes', 'status', 'source', 'emailOptIn', 'whatsappOptIn'] as const;
const addressKinds = ['email', 'phone'] as const;
const addressKey = (kind: 'email' | 'phone', value: string) => kind === 'email' ? value.trim().toLowerCase() : normalizePhone(value);
type MergeAddress = { value: string; label: string };
type PrimaryAddresses = { email?: string; phone?: string };
const empty = (value: unknown) => value === null || value === undefined || value === '';
export async function mergePreview(tx: PoolClient, sourceId: string, targetId: string) {
    if (sourceId === targetId)
        throw new ConflictException('Choose two different students');
    const [source, target] = await Promise.all([requireStudent(tx, sourceId), requireStudent(tx, targetId)]);
    // Aliases are resolved for ordinary reads, but must never silently change a merge request.
    if (source.id !== sourceId || target.id !== targetId)
        throw new ConflictException('A selected student was already merged; refresh the selection');
    const sourceContacts = await listRelatedContacts(tx, sourceId);
    const targetContacts = await listRelatedContacts(tx, targetId);
    // Consolidate only the students' own contacts, including contacts retained by
    // earlier merges. Family, payer and independently linked contacts stay separate.
    const ownRecords = await tx.query<{ id: string }>(
        'SELECT id FROM clients WHERE id=ANY($1::uuid[]) OR merged_into=ANY($1::uuid[])', [[sourceId, targetId]]);
    const ownIds = new Set(ownRecords.rows.map(row => row.id));
    const ownContacts = [...targetContacts, ...sourceContacts].filter(contact =>
        contact.id === sourceId || contact.id === targetId ||
        ownIds.has(contact.id) && ['student', 'self'].includes(contact.relationship));
    const contactAddresses: { email: MergeAddress[]; phone: MergeAddress[] } = { email: [], phone: [] };
    const primaryAddresses: PrimaryAddresses = {};
    for (const kind of addressKinds) {
        const unique = new Map<string, MergeAddress>();
        for (const contact of ownContacts) {
            for (const address of contact[kind === 'email' ? 'emails' : 'phones']) {
                const key = addressKey(kind, address.value);
                if (!unique.has(key)) unique.set(key, { value: address.value, label: address.label });
            }
        }
        // Retain legacy values too, even if their contact link was detached.
        for (const record of [target, source]) {
            const value = record[kind];
            if (value && !unique.has(addressKey(kind, value)))
                unique.set(addressKey(kind, value), { value, label: 'personal' });
        }
        contactAddresses[kind] = [...unique.values()];
        const preferred = target[kind] || source[kind];
        primaryAddresses[kind] = preferred ? unique.get(addressKey(kind, preferred))!.value : contactAddresses[kind][0]?.value;
    }
    const a = item(source), b = item(target), conflicts: {
        field: string;
        source: unknown;
        target: unknown;
    }[] = [];
    for (const field of mergeFields)
        if (!empty(a[field]) && !empty(b[field]) && a[field] !== b[field])
            conflicts.push({
                field, source: a[field], target: b[field]
            });
    for (const key of new Set([...Object.keys(a.customFields), ...Object.keys(b.customFields)]))
        if (!empty(a.customFields[key]) && !empty(b.customFields[key]) && a.customFields[key] !== b.customFields[key])
            conflicts.push({
                field: `custom:${key}`, source: a.customFields[key], target: b.customFields[key]
            });
    const counts = await tx.query<{
        contacts: string;
        payers: string;
        source_identities: string;
        groups: string;
    }>(`SELECT (SELECT count(*) FROM student_contacts WHERE student_id=$1)::text contacts,(SELECT count(*) FROM client_payers WHERE student_id=$1)::text payers,(SELECT count(*) FROM client_external_sources WHERE client_id=$1)::text source_identities,(SELECT count(*) FROM student_group_members WHERE student_id=$1)::text groups`, [source.id]);
    const blockedReasons: string[] = [];
    if (source.portal_protected_at || target.portal_protected_at)
        blockedReasons.push('Portal access or an invitation protects a selected student. Review and revoke grants before a separately authorized unlock.');
    for (const kind of addressKinds)
        if (contactAddresses[kind].length > 20)
            blockedReasons.push(`The combined student contact exceeds 20 ${kind === 'email' ? 'email addresses' : 'phone numbers'}. Review the contact details before merging.`);
    return {
        source: a, target: b, conflicts, contactAddresses, primaryAddresses,
        sourceContacts, targetContacts, consolidatedContactIds: [...new Set([sourceId, targetId, ...ownContacts.map(contact => contact.id)])], affectedLinks: {
            contacts: Number(counts.rows[0]!.contacts), payers: Number(counts.rows[0]!.payers), sourceIdentities: Number(counts.rows[0]!.source_identities), groups: Number(counts.rows[0]!.groups)
        }, blockedReasons, sourceRevision: source.revision, targetRevision: target.revision
    };
}
export async function commitMerge(tx: PoolClient, ctx: RequestContext, input: {
    sourceId: string;
    targetId: string;
    sourceRevision: number;
    targetRevision: number;
    fieldChoices: Record<string, 'source' | 'target'>;
    primaryAddresses?: PrimaryAddresses;
}) {
    const preview = await mergePreview(tx, input.sourceId, input.targetId);
    if (preview.blockedReasons.length)
        throw new ConflictException(preview.blockedReasons.join(' '));
    if (preview.sourceRevision !== input.sourceRevision || preview.targetRevision !== input.targetRevision)
        throw new ConflictException('Student changed after preview; review a new preview');
    const conflictFields = new Set(preview.conflicts.map(c => c.field));
    // Older open merge dialogs submit email/phone as a field choice. Interpret
    // those choices as primary selection; they must never discard an address.
    for (const kind of addressKinds)
        if (!empty(preview.source[kind]) && !empty(preview.target[kind]) && preview.source[kind] !== preview.target[kind])
            conflictFields.add(kind);
    if (preview.conflicts.some(c => !input.fieldChoices[c.field]))
        throw new ConflictException('Choose a survivor value for every conflict');
    if (Object.keys(input.fieldChoices).some(field => !conflictFields.has(field)))
        throw new ConflictException('Field choice does not refer to a current conflict');
    const linkedCount = await tx.query<{
        count: string;
    }>('SELECT count(DISTINCT contact_id) FROM student_contacts WHERE student_id=ANY($1::uuid[]) AND NOT(contact_id=ANY($2::uuid[]))', [[input.sourceId, input.targetId], preview.consolidatedContactIds]);
    if (Number(linkedCount.rows[0]!.count) + 1 > 100)
        throw new ConflictException('Merged contacts exceed 100; detach unnecessary relationships before merging');
    const patch: Record<string, unknown> = {};
    for (const kind of addressKinds) {
        const selected = input.primaryAddresses?.[kind] ??
            (input.fieldChoices[kind] ? preview[input.fieldChoices[kind]][kind] : preview.primaryAddresses[kind]);
        const address = selected ? preview.contactAddresses[kind].find(address => addressKey(kind, address.value) === addressKey(kind, selected)) : undefined;
        if (selected && !address)
            throw new ConflictException(`Choose a primary ${kind} from the retained addresses`);
        patch[kind] = address?.value ?? null;
    }
    for (const field of mergeFields)
        patch[field] = input.fieldChoices[field] === 'source' || empty(preview.target[field]) ? preview.source[field] : preview.target[field];
    patch.tags = [...new Set([...preview.target.tags, ...preview.source.tags])];
    if ((patch.tags as string[]).length > 30)
        throw new ConflictException('Merged tags exceed 30; reduce tags before merging');
    const custom = {
        ...preview.target.customFields
    };
    for (const [key, value] of Object.entries(preview.source.customFields))
        if (empty(custom[key]) || input.fieldChoices[`custom:${key}`] === 'source')
            custom[key] = value;
    if (Object.keys(custom).length > 100)
        throw new ConflictException('Merged custom fields exceed 100');
    patch.customFields = custom;
    // The survivor's own contact can also be shared with other students. Check
    // their scope before adding addresses or changing its primary value.
    const shared = await tx.query<{ student_id: string }>('SELECT student_id FROM student_contacts WHERE contact_id=$1', [input.targetId]);
    for (const link of shared.rows) assertStudentAccess(ctx, link.student_id);
    await tx.query(`INSERT INTO related_contacts(business_id,id,display_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.businessId, input.targetId, patch.displayName]);
    for (const kind of addressKinds)
        for (const address of preview.contactAddresses[kind])
            await tx.query(`INSERT INTO contact_addresses(business_id,id,contact_id,kind,value,normalized_value,label,is_primary) VALUES($1,$2,$3,$4,$5,$6,$7,false) ON CONFLICT(business_id,contact_id,kind,normalized_value) DO NOTHING`,
                [ctx.businessId, randomUUID(), input.targetId, kind, address.value, addressKey(kind, address.value), address.label]);
    const row = await updateContact(tx, ctx.businessId, input.targetId, patch as ContactPatch, ctx.requestId, false);
    await tx.query(`INSERT INTO student_contacts(business_id,student_id,contact_id,relationship,is_primary) SELECT business_id,$2,contact_id,relationship,false FROM student_contacts WHERE student_id=$1 ON CONFLICT DO NOTHING`, [input.sourceId, input.targetId]);
    await tx.query('DELETE FROM student_contacts WHERE student_id=$1', [input.sourceId]);
    // Their addresses now live on one student contact. Keep original contact
    // records and their other relationships intact for shared contacts/history.
    await tx.query('DELETE FROM student_contacts WHERE student_id=$1 AND contact_id=ANY($2::uuid[]) AND contact_id<>$1', [input.targetId, preview.consolidatedContactIds]);
    await tx.query(`INSERT INTO client_payers(business_id,student_id,payer_id,relationship) SELECT business_id,$2,payer_id,relationship FROM client_payers WHERE student_id=$1 ON CONFLICT DO NOTHING`, [input.sourceId, input.targetId]);
    await tx.query('DELETE FROM client_payers WHERE student_id=$1', [input.sourceId]);
    await remapStudentGroups(tx, ctx, input.sourceId, input.targetId);
    await tx.query('UPDATE client_external_sources SET client_id=$2 WHERE client_id=$1', [input.sourceId, input.targetId]);
    // Flatten any older alias chain, while retaining its original source and audit.
    await tx.query('UPDATE clients SET merged_into=$2 WHERE merged_into=$1', [input.sourceId, input.targetId]);
    await tx.query('UPDATE clients SET merged_into=$2,merged_at=now(),revision=revision+1,updated_at=now() WHERE id=$1', [input.sourceId, input.targetId]);
    const id = randomUUID();
    await tx.query('INSERT INTO student_merge_audit(business_id,id,source_id,target_id,actor_id,source_snapshot,target_snapshot,field_choices,revision) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)', [ctx.businessId, id, input.sourceId, input.targetId, ctx.sub, JSON.stringify({ ...preview.source, contacts: preview.sourceContacts }), JSON.stringify({ ...preview.target, contacts: preview.targetContacts }), JSON.stringify({ ...input.fieldChoices, primaryAddresses: { email: row.email, phone: row.phone } }), row.revision]);
    await emitEvent(tx, {
        type: 'clients.student-merged.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
            sourceId: input.sourceId, targetId: input.targetId, revision: row.revision
        }
    });
    return {
        item: item(row), merge: {
            id, sourceId: input.sourceId, targetId: input.targetId, revision: row.revision
        }
    };
}
