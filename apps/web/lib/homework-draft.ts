export type HomeworkDraft = { revision: number; text: string; url: string; savedAt: number };
const prefix = 'tuts:homework-draft:';
export function homeworkDraftKey(authorId: string, businessId: string, studentId: string, assignmentId: string) {
  return `${prefix}${authorId}:${businessId}:${studentId}:${assignmentId}`;
}
export function readHomeworkDraft(storage: Pick<Storage, 'getItem'>, key: string, revision: number, now = Date.now()): HomeworkDraft | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    return value && value.revision === revision && typeof value.text === 'string' && value.text.length <= 10000 && typeof value.url === 'string' && value.url.length <= 2000 && typeof value.savedAt === 'number' && value.savedAt <= now && now - value.savedAt < 24 * 60 * 60_000 ? value : null;
  } catch { return null; }
}
export function clearHomeworkDrafts(storage: Storage, authorId: string) {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key?.startsWith(`${prefix}${authorId}:`)) storage.removeItem(key);
  }
}
