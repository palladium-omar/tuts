import type { Row } from "../../lib/api";
/** A provider cancellation describes the booking; it does not rewrite tutor attendance. */
export function studentSessionStatus(session: Row): string {
  return session.providerStatus === "cancelled" ? "cancelled" : session.status;
}
export function studentSessionStatusLabel(session: Row): string {
  const status = studentSessionStatus(session);
  return ({ scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", no_show: "No-show" } as Record<string,string>)[status] ?? status;
}
