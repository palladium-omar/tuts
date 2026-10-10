const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const detailTabs = ['summary', 'contacts', 'documents', 'learning', 'sessions', 'payments', 'activity'];
export const tutorLocationKeys = ['contact', 'group', 'student', 'trackerView', 'trackerTab'] as const;
export type TutorLocationKey = typeof tutorLocationKeys[number];
export function readTrackerLocation(params: URLSearchParams, businessId: string) {
  if (params.get('business') !== businessId || params.get('view') !== 'tracker') return {view:'groups', groupId:null, studentId:null, tab:'summary'};
  const id = (key: string) => uuid.test(params.get(key) ?? '') ? params.get(key) : null;
  const view = params.get('trackerView');
  const tab = params.get('trackerTab');
  return {view: view === 'all' || view === 'unassigned' ? view : 'groups', groupId:id('group'), studentId:id('student'), tab:detailTabs.includes(tab ?? '') ? tab! : 'summary'};
}
export function readContactLocation(params: URLSearchParams, businessId: string) {
  const id = params.get('contact');
  return params.get('business') === businessId && params.get('view') === 'clients' && uuid.test(id ?? '') ? id : null;
}
/** The URL identifies a record; only the service decides whether it is accessible. */
export function tutorLocation(params: URLSearchParams, businessId: string, view: 'clients' | 'tracker', patch: Partial<Record<TutorLocationKey, string | null>>) {
  const next = new URLSearchParams(params);
  if (next.get('business') !== businessId || next.get('view') !== view) tutorLocationKeys.forEach(key => next.delete(key));
  next.set('business', businessId); next.set('view', view);
  for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
  return next;
}
export function navigateTutor(businessId: string, view: 'clients' | 'tracker', patch: Partial<Record<TutorLocationKey, string | null>>, replace = false) {
  const url = new URL(window.location.href);
  url.search = tutorLocation(url.searchParams, businessId, view, patch).toString();
  if (url.href !== window.location.href) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
}
export function contactDisplayName(original: {firstName?: string; lastName?: string; displayName?: string} | null, firstName: string, lastName: string, input: string) {
  const generated = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
  const previous = [original?.firstName?.trim(), original?.lastName?.trim()].filter(Boolean).join(' ');
  const provided = input.trim();
  return !provided || (original?.displayName === previous && provided === original.displayName) ? generated : provided;
}
export function tutorHomeworkOrder<T extends {status?: string; dueAt?: string | null; title?: string}>(assignments: T[]): T[] {
  const priority: Record<string, number> = {submitted:0, needs_revision:1, assigned:2, completed:3};
  return [...assignments].sort((left, right) => (priority[left.status ?? ''] ?? 4) - (priority[right.status ?? ''] ?? 4)
    || (left.dueAt ? Date.parse(left.dueAt) : Infinity) - (right.dueAt ? Date.parse(right.dueAt) : Infinity)
    || (left.title ?? '').localeCompare(right.title ?? ''));
}
