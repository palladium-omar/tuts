import {deadlineCaption, deadlineTime} from '../../lib/student-board-presentation';
export function overviewLink(current: string, studentId: string, section: string, boardId?: string, cardId?: string) {
  const url = new URL(current);
  url.searchParams.set('student', studentId); url.searchParams.set('section', section);
  url.searchParams.delete('board'); url.searchParams.delete('card'); url.searchParams.delete('assignment');
  if (boardId) url.searchParams.set('board', boardId);
  if (boardId && cardId) url.searchParams.set('card', cardId);
  return `${url.pathname}${url.search}${url.hash}`;
}
export function progressPercent(completed: number, total: number) {
  return total > 0 ? Math.round(Math.max(0, Math.min(completed, total)) / total * 100) : 0;
}

export type OverviewDomain = 'learning' | 'planning' | 'scheduling';
/** Re-entering Overview must observe saved work, even within the API cache TTL. */
export async function fetchOverview(api: import('../../lib/api').Api, domain: OverviewDomain, studentId: string) {
  return api(`${domain}/v1/${domain === 'planning' ? '' : 'portal/'}overview?studentId=${encodeURIComponent(studentId)}`, 'GET', undefined, undefined, { fresh: true });
}

export function planningDeadlineDate(deadline: unknown): string | null {
  const value = typeof deadline === 'string' ? deadline : deadline && typeof deadline === 'object' && 'dueAt' in deadline ? (deadline as {dueAt:unknown}).dueAt : null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

export function overviewDeadlineLabel(deadline: unknown, now = Date.now()): string | null {
  const dueAt = planningDeadlineDate(deadline);
  if (!dueAt) return null;
  const record = typeof deadline === 'object' && deadline ? deadline as Record<string, any> : {dueAt};
  const caption = deadlineCaption(record).replace('Personal target', 'Personal deadline');
  const suggested = caption === 'Suggested target';
  let when: string;
  if (suggested) {
    try { when = new Intl.DateTimeFormat(undefined, {month:'short',day:'numeric',timeZone:record.timeZone}).format(new Date(dueAt)); }
    catch { when = new Intl.DateTimeFormat(undefined, {month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(dueAt)); }
  } else when = deadlineTime({...record,dueAt});
  const delta = Date.parse(dueAt) - now;
  const timing = delta < 0 ? suggested ? ' · target passed' : ' · past due' : delta <= 7*86400000 ? ' · coming up' : '';
  return `${caption} · ${when}${timing}`;
}

export function priorityPlanningTasks(tasks: import('../../lib/api').Row[], upcomingTasks: import('../../lib/api').Row[] = []) {
  const upcomingIds = new Set(upcomingTasks.slice(0, 5).map(task => task.id));
  return tasks.filter(task => !upcomingIds.has(task.id)).slice(0, 5);
}
