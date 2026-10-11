import { ApiError, type Api, type Row } from "../../lib/api";
export const portalUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
export function homeworkLink(current: string, studentId: string, assignmentId: string, businessId?: string) {
  if (!portalUuid(studentId) || !portalUuid(assignmentId)) return null;
  const url = new URL(current); url.pathname = "/portal";
  if (businessId) url.searchParams.set("business", businessId);
  url.searchParams.set("student", studentId); url.searchParams.set("section", "homework"); url.searchParams.set("assignment", assignmentId);
  url.searchParams.delete("board"); url.searchParams.delete("card");
  return `${url.pathname}${url.search}${url.hash}`;
}
export function withoutAssignment(current: string) {
  const url = new URL(current); url.searchParams.delete("assignment");
  return `${url.pathname}${url.search}${url.hash}`;
}
export function homeworkOpenError(error: unknown) {
  if (error instanceof ApiError && [401,403,404].includes(error.status)) return "This assignment is unavailable for this student or your access has changed.";
  return "Couldn’t open this assignment. Please retry.";
}
/** Detail loading is independent of list pagination/filtering and fails closed on mismatched student data. */
export async function loadLinkedHomework(api: Api, studentId: string, assignmentId: string, signal: AbortSignal): Promise<Row> {
  if (!portalUuid(studentId) || !portalUuid(assignmentId)) throw new Error("This homework link is invalid.");
  const data = await api(`learning/v1/portal/assignments/${assignmentId}`, "GET", undefined, undefined, {signal, fresh:true});
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  if (!data.item || !portalUuid(data.item.id) || !portalUuid(data.item.clientId) || data.item.id.toLowerCase() !== assignmentId.toLowerCase() || data.item.clientId?.toLowerCase() !== studentId.toLowerCase()) throw new ApiError("Assignment unavailable",404);
  return data.item;
}

/** Navigation can outlive a pending write; its completion may update only the work that started it. */
export function createHomeworkWorkGuard() {
  let active = false, generation = 0;
  return {
    activate() { active = true; generation += 1; },
    deactivate() { active = false; generation += 1; },
    ticket() { const started = generation; return () => active && generation === started; },
  };
}
