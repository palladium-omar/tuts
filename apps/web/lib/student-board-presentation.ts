import { date, type Row } from "./api";

export function publicLink(value: string) { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } }
export function deadlineTime(deadline: Row) { try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: deadline.timeZone }).format(new Date(deadline.dueAt)); } catch { return date(deadline.dueAt); } }
export function deadlineCaption(deadline: Row) { return deadline.kind === "personal" ? (deadline.status === "requires_confirmation" ? "Suggested target" : "Personal target") : deadline.status === "verified" ? "Official deadline" : "Official date · confirm"; }

export function templateBrand(key: string) { return key.startsWith("common-app") ? "commonapp" : key.startsWith("campus-france") ? "campusfrance" : key.startsWith("sat") || key.startsWith("college-board") ? "collegeboard" : key.split("-")[0]; }

export function deadlinePreviewTime(deadline: Row) { if (deadline.kind !== "personal") return `${deadlineTime(deadline)} (${deadline.timeZone})`; try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: deadline.timeZone }).format(new Date(deadline.dueAt)); } catch { return date(deadline.dueAt); } }
