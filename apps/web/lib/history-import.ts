import type { Row } from "./api";

export const historyFields: Record<string, string> = {
  date: "Date",
  studentName: "Student or payer",
  serviceType: "Service",
  hours: "Hours worked",
  rateMinor: "Hourly rate",
  amountMinor: "Total amount",
  status: "Payment status",
  notes: "Notes",
  invoiceNumber: "Invoice number",
  paidDate: "Payment date",
};
export const historyStatusName = (status: string) =>
  ({ unsent: "Unsent", pending: "Pending · awaiting payment", paid: "Paid" })[
    status
  ] || "Choose a meaning";
export const normalizeStatusLabel = (label: string) =>
  label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function observedStatuses(preview: Row): Row[] {
  if (Array.isArray(preview.statusLabels)) return preview.statusLabels;
  // Older servers may not send source labels. Never present their entire default map as questions.
  return [];
}
export function effectiveMapping(
  preview: Row,
  options: Row,
): Record<string, string> {
  return { ...preview.mapping, ...options.mapping };
}
export function currencySuggestion(
  preview: Row,
  businessCurrency?: string,
): string {
  const candidate =
    preview.currencyVariants?.length === 1
      ? preview.currencyVariants[0]
      : preview.detectedCurrency || businessCurrency || "EUR";
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: candidate });
    return candidate;
  } catch {
    return "EUR";
  }
}
export function currencySettings(
  options: Row,
  preview: Row,
  currency: string,
  useColumn: boolean,
): Row {
  return {
    ...options,
    currency,
    mapping: {
      ...options.mapping,
      ...(preview.currencyColumn
        ? { currency: useColumn ? preview.currencyColumn : "" }
        : {}),
    },
  };
}
export function matchingFields(
  preview: Row,
  options: Row,
  showAll = false,
): string[] {
  const mapping = effectiveMapping(preview, options);
  const required =
    preview.kind === "invoices"
      ? ["studentName", "amountMinor", "status"]
      : ["date", "studentName", "hours", "amountMinor", "status"];
  return Object.keys(historyFields).filter(
    (key) => showAll || mapping[key] || required.includes(key),
  );
}
export function freshImportOptions(kind: string, sheetName?: string): Row {
  return { kind, countAsClasses: false, ...(sheetName ? { sheetName } : {}) };
}

export function canCommitHistory(
  preview: Row | null,
  state: { busy: boolean; dirty: boolean; accepted: boolean; partial: boolean },
): boolean {
  if (!preview?.token || state.busy || state.dirty || !state.accepted)
    return false;
  return (
    preview.kind === "archive" ||
    (preview.summary.valid > 0 && (!preview.summary.invalid || state.partial))
  );
}
