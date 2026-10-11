import type { Row } from './api';

export type StudentDecision = { action: 'create' | 'link' | 'skip'; studentId?: string; rowIds: string[] };
export function suggestedStudentDecision(group: Row): StudentDecision {
  const rowIds = group.rows.filter((row: Row) => row.identity?.status !== 'linked').map((row: Row) => row.id);
  if (!rowIds.length) return { action: 'skip', rowIds };
  if (group.resolvedStudentId) return group.resolvedAction === 'create' ? { action: 'create', rowIds } : { action: 'link', studentId: group.resolvedStudentId, rowIds };
  if (group.ambiguous || (group.candidates?.length ?? 0) > 1) return { action: 'skip', rowIds };
  if (group.candidates?.length === 1) return { action: 'link', studentId: group.candidates[0].id, rowIds };
  return { action: 'create', rowIds };
}
export async function workGroupKey(ids: string[]): Promise<string> {
  const bytes = new TextEncoder().encode([...ids].map(id => id.toLowerCase()).sort().join('\n'));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function selectedWorkRows(group: Row, decision: StudentDecision): Row[] {
  const ids = new Set(decision.rowIds);
  return group.rows.filter((row: Row) => ids.has(row.id));
}
export function studentReviewCounts(groups: Row[], decisions: Record<string, StudentDecision>) {
  let created = 0, linked = 0, rows = 0, skipped = 0;
  for (const group of groups) {
    const decision = decisions[group.key];
    if (!decision || decision.action === 'skip' || !decision.rowIds.length) { skipped++; continue; }
    if (decision.action === 'create' && !group.resolvedStudentId) created++;
    else if (group.resolvedStudentId || decision.studentId) linked++;
    else continue;
    rows += selectedWorkRows(group, decision).length;
  }
  return { created, linked, rows, skipped };
}
