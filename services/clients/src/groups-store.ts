import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RequestContext } from '@palladium/contracts';
import { emitEvent } from '@palladium/service-kit';
export type GroupRow = {
    id: string;
    name: string;
    description: string | null;
    revision: number;
    student_count: string;
    created_at: Date;
    updated_at: Date;
};
export const groupItem = (r: GroupRow) => ({
    id: r.id, name: r.name, description: r.description, revision: r.revision, studentCount: Number(r.student_count), createdAt: r.created_at, updatedAt: r.updated_at
});
export const groupSelect = `SELECT g.*,(SELECT count(*) FROM student_group_members m WHERE m.group_id=g.id AND m.business_id=g.business_id)::text student_count FROM student_groups g`;
export async function requireGroup(tx: PoolClient, id: string) {
    const row = await tx.query<GroupRow>(`${groupSelect} WHERE g.id=$1`, [id]);
    if (!row.rows[0])
        throw new NotFoundException('Group was not found');
    return row.rows[0];
}
export async function emitGroupMembers(tx: PoolClient, ctx: RequestContext, groupId: string, studentIds: string[], action: 'added' | 'removed') {
    if (!studentIds.length)
        return;
    const row = await tx.query<{
        revision: number;
    }>('UPDATE student_groups SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision', [groupId]);
    await emitEvent(tx, {
        type: `clients.group-members-${action}.v1`, producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
            groupId, studentIds, revision: row.rows[0]!.revision
        }
    });
}
export async function remapStudentGroups(tx: PoolClient, ctx: RequestContext, sourceId: string, targetId: string) {
    const groups = await tx.query<{
        group_id: string;
    }>('SELECT group_id FROM student_group_members WHERE student_id=$1 ORDER BY group_id', [sourceId]);
    for (const { group_id: groupId } of groups.rows) {
        const inserted = await tx.query('INSERT INTO student_group_members(business_id,group_id,student_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING student_id', [ctx.businessId, groupId, targetId]);
        await tx.query('DELETE FROM student_group_members WHERE group_id=$1 AND student_id=$2', [groupId, sourceId]);
        await emitGroupMembers(tx, ctx, groupId, [sourceId], 'removed');
        if (inserted.rowCount)
            await emitGroupMembers(tx, ctx, groupId, [targetId], 'added');
    }
}
