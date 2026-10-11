import type { Row } from "./api";
import { decimalMinor } from "./history-money";

/** Amount already assigned to this invoice, including its current allocation. */
export function linkedWorkMinor(row: Row): number {
  return Math.max(0, Number(row.linkedMinor) || 0);
}

/** Remaining work that this invoice may cover, crediting its own existing link. */
export function availableWorkMinor(row: Row): number {
  return Math.max(0, (Number(row.amountMinor) || 0) - (Number(row.coveredMinor) || 0) + linkedWorkMinor(row));
}

/** New work links start with the uncovered contribution; existing links keep their reviewed amount. */
export function defaultWorkLinkMinor(row: Row): number {
  const linked = linkedWorkMinor(row);
  return linked > 0 ? linked : availableWorkMinor(row);
}

export function previewCurrencyRows(data: Row): Row[] {
  if (Array.isArray(data.currencies)) return data.currencies;
  if (Array.isArray(data.totals)) return data.totals;
  const before: Row[] = Array.isArray(data.before) ? data.before : data.before ? [data.before] : [];
  const after: Row[] = Array.isArray(data.after) ? data.after : data.after ? [data.after] : [];
  return [...new Set([...before, ...after].map(row => row.currency).filter(Boolean))].map(currency => ({
    currency,
    before: before.find(row => row.currency === currency) || {},
    after: after.find(row => row.currency === currency) || {},
  }));
}

/** Keep the same key for an unchanged retry; a changed request gets a new key. */
export function stableRetryKey(keys: Map<string, string>, fingerprint: string, prefix: string, createId: () => string): string {
  const existing = keys.get(fingerprint);
  if (existing) return existing;
  const key = `${prefix}:${createId()}`;
  keys.set(fingerprint, key);
  return key;
}

export type PreviewSnapshot<T extends Record<string, unknown> = Row> = {
  businessId: string;
  invoiceId: string;
  generation: number;
  decision: T;
};

export type InvoiceRevisionGuard = { invoiceId: string; revision: number };

/** Capture the server's pre-change revisions separately from the frozen preview request. */
export function createPublishSnapshot<T extends Record<string, unknown>>(
  previewSnapshot: PreviewSnapshot<T>,
  invoiceGuards: InvoiceRevisionGuard[],
): PreviewSnapshot<T & { invoiceGuards: InvoiceRevisionGuard[] }> {
  return createPreviewSnapshot({ ...previewSnapshot.decision, invoiceGuards }, previewSnapshot.businessId, previewSnapshot.invoiceId, previewSnapshot.generation);
}

/** Ensure the server provided one guard for every other invoice refreshed by this preview. */
export function previewInvoiceGuards(preview: Row): InvoiceRevisionGuard[] {
  const affected: Row[] = Array.isArray(preview.affectedInvoices) ? preview.affectedInvoices : [];
  const targetId = preview.invoiceId;
  const expectedIds = affected.map(row => row.invoiceId).filter((id: string) => id && id !== targetId).sort();
  const raw: Row[] = Array.isArray(preview.guards?.invoices) ? preview.guards.invoices : [];
  const guards = raw.map(row => ({ invoiceId: row.invoiceId, revision: row.revision }));
  const actualIds = guards.map(row => row.invoiceId).sort();
  if (expectedIds.length !== actualIds.length || expectedIds.some((id: string, index: number) => id !== actualIds[index]) || guards.some(row => typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision <= 0)) {
    throw new Error("Some linked invoices changed while preparing this review. Refresh the invoice and prepare a new preview.");
  }
  return guards;
}

/** Capture the exact decision previewed, detached from later UI state edits. */
export function createPreviewSnapshot<T extends Record<string, unknown>>(
  decision: T,
  businessId: string,
  invoiceId: string,
  generation: number,
): PreviewSnapshot<T> {
  const detached = JSON.parse(JSON.stringify(decision)) as T;
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  };
  freeze(detached);
  return Object.freeze({ businessId, invoiceId, generation, decision: detached });
}

/** Ignore responses from a closed invoice, changed tenant, aborted request, or older preview. */
export function previewScopeIsCurrent(
  snapshot: PreviewSnapshot,
  current: { businessId: string; invoiceId: string; generation: number; aborted?: boolean },
): boolean {
  return !current.aborted && snapshot.businessId === current.businessId &&
    snapshot.invoiceId === current.invoiceId && snapshot.generation === current.generation;
}

/** Human-readable invoices whose shared work records will also be refreshed. */
export function affectedInvoiceSummaries(preview: Row, knownInvoices: Row[]): { invoiceId: string; label: string; workCount: number }[] {
  const known = new Map(knownInvoices.filter(row => row.id).map(row => [row.id, row]));
  const affected: Row[] = Array.isArray(preview.affectedInvoices) ? preview.affectedInvoices : [];
  return affected.filter(row => row.invoiceId && row.invoiceId !== preview.invoiceId).map(row => {
    const invoice = known.get(row.invoiceId) || {};
    const label = invoice.invoiceNumber || invoice.number || invoice.fileName || `Invoice ${String(row.invoiceId).slice(0, 8)}`;
    const workIds: unknown[] = Array.isArray(row.workIds) ? row.workIds : [];
    return { invoiceId: row.invoiceId, label, workCount: workIds.length };
  });
}

/** Restart receipt recovery after the final page so a later check sees new transactions. */
export function nextReceiptOffset(result: Row, currentOffset: number): number {
  if (!result.hasMore) return 0;
  return Number.isInteger(result.nextOffset) ? result.nextOffset : currentOffset + (Number(result.imported) || 0);
}

export function receiptIsSimulated(receipt: Row): boolean {
  return receipt.simulated === true || receipt.evidence === "simulated";
}

export function summarizeWorkLinks(rows: Row[], amounts: Record<string, string>, currency: string): { count: number; amountMinor: number; hasInvalidAmount: boolean } {
  let count = 0, amountMinor = 0, hasInvalidAmount = false;
  for (const row of rows) {
    const value = amounts[row.id];
    if (!value) continue;
    try {
      const amount = decimalMinor(value, row.currency || currency);
      if (amount <= 0) hasInvalidAmount = true;
      else { count++; amountMinor += amount; }
    } catch { hasInvalidAmount = true; }
  }
  return { count, amountMinor, hasInvalidAmount };
}

export function receiptAllocatedMinor(receipt: Row, invoiceId: string): number {
  if (typeof receipt.allocatedMinor === "number") return receipt.allocatedMinor;
  return (receipt.allocations || []).filter((allocation: Row) => allocation.invoiceId === invoiceId)
    .reduce((sum: number, allocation: Row) => sum + (Number(allocation.amountMinor) || 0), 0);
}

export function uniqueInvoiceNames(row: Row): string[] {
  return [...new Set([row.payerName, row.studentName, ...(Array.isArray(row.studentNames) ? row.studentNames : [])]
    .map(value => typeof value === "string" ? value.trim() : "").filter(Boolean))];
}

export function serviceMonthParts(value: string): { month: string; year: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? { year: match[1], month: match[2] } : { month: "", year: "" };
}

export function combineServiceMonth(month: string, year: string): string {
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) return "";
  return `${year}-${month}`;
}

export function hasPartialServiceMonth(month: string, year: string): boolean {
  return Boolean(month) !== Boolean(year);
}

/** Offer years around the current and invoice dates, while retaining known older service years. */
export function serviceYearOptions(currentYear: number, invoiceDate = "", knownServiceMonth = "", draftYear = ""): string[] {
  const invoiceYear = /^\d{4}/.exec(invoiceDate)?.[0];
  const anchors = [currentYear, invoiceYear ? Number(invoiceYear) : currentYear];
  const first = Math.min(...anchors) - 15, last = Math.max(...anchors) + 3;
  const years = new Set<string>();
  for (let year = first; year <= last; year++) years.add(String(year));
  const knownYear = serviceMonthParts(knownServiceMonth).year;
  if (knownYear) years.add(knownYear);
  if (/^\d{4}$/.test(draftYear)) years.add(draftYear);
  return [...years].sort((left, right) => Number(left) - Number(right));
}
