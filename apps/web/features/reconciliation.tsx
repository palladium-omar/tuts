import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { hasPermission, canReadFinancial } from "@palladium/contracts";
import { Empty, Modal, Notice } from "../components/shared";
import { errorMessage, money, type Api, type Business, type Row } from "../lib/api";
import { currencyScale, decimalMinor } from "../lib/history-money";
import { affectedInvoiceSummaries, availableWorkMinor, combineServiceMonth, createPreviewSnapshot, createPublishSnapshot, defaultWorkLinkMinor, hasPartialServiceMonth, linkedWorkMinor, nextReceiptOffset, previewCurrencyRows, previewInvoiceGuards, previewScopeIsCurrent, receiptAllocatedMinor, receiptIsSimulated, serviceMonthParts, serviceYearOptions, stableRetryKey, summarizeWorkLinks, uniqueInvoiceNames, type PreviewSnapshot } from "../lib/reconciliation";
import "./reconciliation.css";

const base = "billing/v1/reconciliation";
const uuid = () => crypto.randomUUID();
const formatMinor = (value: unknown, currency: string) => typeof value === "number" && Number.isFinite(value) ? money(value, currency) : "—";
const displayName = (row: Row) => row.displayName || row.name || row.fullName || `Student ${String(row.id || "").slice(0, 8)}`;
const detailAmount = (row: Row) => row.amountMinor ?? row.totalMinor ?? row.faceAmountMinor ?? 0;

type Candidate = Row;
type Detail = { invoice?: Row; source?: Row; aliases?: Row[]; students?: Row[]; payers?: Row[]; work?: Row[]; receipts?: Row[]; suggestions?: Row; workLimit?: number; receiptLimit?: number };

export function Reconciliation({ api, business, onClose, onChanged }: { api: Api; business: Business; onClose?: () => void; onChanged?: () => void }) {
  const canRead = canReadFinancial(business) && business.entitlements.includes("billing");
  const canWrite = canRead && hasPermission(business, "billing.write");
  const canReadClients = business.entitlements.includes("clients") && hasPermission(business, "clients.read");
  const [tab, setTab] = useState<"invoices" | "payments">("invoices");
  const [listState, setListState] = useState<"unresolved" | "accepted">("unresolved");
  const [revision, setRevision] = useState(0), [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null), [targetDetail, setTargetDetail] = useState<Detail | null>(null), [selected, setSelected] = useState<Row | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [step, setStep] = useState(1), [choice, setChoice] = useState<"new" | "existing">("new");
  const [canonicalId, setCanonicalId] = useState(""), [canonicalRevision, setCanonicalRevision] = useState(0), [studentIds, setStudentIds] = useState<string[]>([]), [payerId, setPayerId] = useState("");
  const [studentQuery, setStudentQuery] = useState(""), [payerQuery, setPayerQuery] = useState("");
  const [students, setStudents] = useState<Candidate[]>([]), [payers, setPayers] = useState<Candidate[]>([]);
  const [canonicalNames, setCanonicalNames] = useState<Record<string, string>>({});
  const [workLinks, setWorkLinks] = useState<Record<string, string>>({}), [serviceMonth, setServiceMonth] = useState(""), [serviceMonthPart, setServiceMonthPart] = useState(""), [serviceYearPart, setServiceYearPart] = useState(""), [dueDate, setDueDate] = useState("");
  const [workFilter, setWorkFilter] = useState("");
  const [preview, setPreview] = useState<Row | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [acceptedInvoices, setAcceptedInvoices] = useState<Row[]>([]), [receipts, setReceipts] = useState<Row[]>([]);
  const [allocating, setAllocating] = useState<Row | null>(null), [allocationInvoice, setAllocationInvoice] = useState(""), [allocationAmount, setAllocationAmount] = useState("");
  const [adjusting, setAdjusting] = useState<Row | null>(null);
  const request = useRef<AbortController | null>(null), sequence = useRef(0), scope = useRef(business.id);
  const previewAbort = useRef<AbortController | null>(null), previewGeneration = useRef(0);
  const previewSnapshot = useRef<(PreviewSnapshot & { preview?: Row; publishDecision?: Row }) | null>(null);
  const publishAbort = useRef<AbortController | null>(null);
  const retryKeys = useRef(new Map<string, string>());
  const [page, setPage] = useState(0), [acceptedOffset, setAcceptedOffset] = useState(0), [acceptedTotal, setAcceptedTotal] = useState(0);
  const [syncOffset, setSyncOffset] = useState(0), [syncHasMore, setSyncHasMore] = useState(false);
  const [receiptOffset, setReceiptOffset] = useState(0), [receiptTotal, setReceiptTotal] = useState(0), [addingHistorical, setAddingHistorical] = useState(false);
  useEffect(() => { setPage(0); }, [search, listState]);

  useEffect(() => {
    scope.current = business.id;
    request.current?.abort();
    previewAbort.current?.abort(); previewAbort.current = null; publishAbort.current?.abort(); publishAbort.current = null; previewGeneration.current++; previewSnapshot.current = null;
    sequence.current++;
    setDetail(null); setTargetDetail(null); setSelected(null); setPreview(null); setRows([]); setError(""); setNotice("");
    setStudentIds([]); setPayerId(""); setCanonicalId(""); setCanonicalRevision(0); setBusy(""); setAcceptedInvoices([]); setAcceptedOffset(0); setAcceptedTotal(0); setReceipts([]); setReceiptOffset(0); setReceiptTotal(0); setSyncOffset(0); setSyncHasMore(false); setPreview(null); retryKeys.current.clear();
  }, [business.id]);
  useEffect(() => () => { scope.current = ""; request.current?.abort(); previewAbort.current?.abort(); publishAbort.current?.abort(); previewGeneration.current++; previewSnapshot.current = null; sequence.current++; }, []);

  useEffect(() => {
    if (!canRead) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const current = ++sequence.current, businessId = business.id;
    setLoading(true); setError("");
    const query = new URLSearchParams({ state: listState, limit: "50", offset: String(page * 50) });
    if (search.trim()) query.set("search", search.trim());
    api(`${base}/invoices?${query}`, "GET", undefined, undefined, { signal: controller.signal, fresh: revision > 0 })
      .then(result => { if (current === sequence.current && scope.current === businessId && !controller.signal.aborted) { setRows(result.items || []); setTotal(result.total || 0); } })
      .catch(reason => { if (current === sequence.current && !controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (current === sequence.current) setLoading(false); });
    return () => { controller.abort(); };
  }, [api, business.id, canRead, listState, search, revision, page]);

  useEffect(() => {
    if (!canReadClients || !studentQuery.trim()) { setStudents([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => api(`clients/v1/clients?kind=student&limit=20&offset=0&search=${encodeURIComponent(studentQuery.trim())}`, "GET", undefined, undefined, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && scope.current === business.id) setStudents(result.items || []); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); }), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, business.id, canReadClients, studentQuery]);
  useEffect(() => {
    if (!canReadClients || !payerQuery.trim()) { setPayers([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => api(`clients/v1/clients?kind=payer&limit=20&offset=0&search=${encodeURIComponent(payerQuery.trim())}`, "GET", undefined, undefined, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && scope.current === business.id) setPayers(result.items || []); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); }), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, business.id, canReadClients, payerQuery]);
  const linkedIdentityIds = [...(detail?.students || []), ...(detail?.payers || []), ...(targetDetail?.students || []), ...(targetDetail?.payers || [])].map(person => person.id).filter(Boolean);
  useEffect(() => {
    if (!canReadClients || !linkedIdentityIds.length) { setCanonicalNames({}); return; }
    const controller = new AbortController(), businessId = business.id, ids = [...new Set(linkedIdentityIds)].slice(0, 20), names: Record<string, string> = {};
    let cursor = 0;
    const readBatch = async () => {
      while (cursor < ids.length && !controller.signal.aborted) {
        const id = ids[cursor++];
        try { const result = await api(`clients/v1/clients/${encodeURIComponent(id)}`, "GET", undefined, undefined, { signal: controller.signal }); const name = result.item?.displayName || result.item?.name; if (name) names[id] = name; }
        catch { /* Keep the clearly labeled CRM ID when a name is unavailable. */ }
      }
    };
    setCanonicalNames({});
    void Promise.all(Array.from({ length: Math.min(5, ids.length) }, readBatch)).then(() => {
      if (!controller.signal.aborted && scope.current === businessId) setCanonicalNames(names);
    });
    return () => controller.abort();
  }, [api, business.id, canReadClients, detail, targetDetail]);

  const invoice = detail?.invoice || {};
  const workById = new Map<string, Row>();
  (detail?.work || []).forEach(row => workById.set(row.id, row));
  (targetDetail?.work || []).forEach(row => { if (linkedWorkMinor(row) > 0 || !workById.has(row.id)) workById.set(row.id, row); });
  const workRows = [...workById.values()].filter(row => !invoice.currency || row.currency === invoice.currency)
    .sort((left, right) => linkedWorkMinor(right) - linkedWorkMinor(left));
  const savedStudentRows = [...new Map([...(targetDetail?.students || []), ...(detail?.students || [])].map(row => [row.id, row])).values()];
  const savedPayerRows = [...new Map([...(targetDetail?.payers || []), ...(detail?.payers || [])].map(row => [row.id, row])).values()];
  const reviewInvoice = targetDetail?.invoice || invoice;
  const reviewDetail = targetDetail || detail;
  const serviceMonthLocked = choice === "existing" && Boolean(reviewInvoice.serviceMonth);
  const serviceYears = serviceYearOptions(new Date().getFullYear(), invoice.invoiceDate || invoice.date || selected?.invoiceDate || "", reviewInvoice.serviceMonth || "", serviceYearPart);
  const filterText = workFilter.trim().toLocaleLowerCase();
  const visibleWorkRows = filterText ? workRows.filter(row => [row.studentName, row.payerName].some(name => typeof name === "string" && name.toLocaleLowerCase().includes(filterText))) : workRows;
  const workSummary = summarizeWorkLinks(workRows, workLinks, invoice.currency || selected?.currency || "EUR");
  const invoiceReceipts = (reviewDetail?.receipts || []).filter(receipt => receiptAllocatedMinor(receipt, reviewInvoice.id) > 0);
  const savedStudentIds = new Set(savedStudentRows.map(student => student.id).filter(Boolean));
  const savedPayerId = savedPayerRows[0]?.id || "";
  const linkedLabel = (person: Row, kind: "student" | "payer") => person.name || canonicalNames[person.id] || `Linked ${kind} ID ${String(person.id).slice(0, 8)}`;
  const source = detail?.source || selected?.source || selected || {};
  const currencies = useMemo(() => [...new Set([...rows.map(row => row.currency), ...receipts.map(row => row.currency)].filter(Boolean))], [rows, receipts]);
  const refreshedInvoices = preview ? affectedInvoiceSummaries(preview, [...rows, ...acceptedInvoices, invoice, targetDetail?.invoice || {}, selected || {}]) : [];
  function setServiceMonthDraft(value: string) {
    const parts = serviceMonthParts(value);
    setServiceMonth(combineServiceMonth(parts.month, parts.year)); setServiceMonthPart(parts.month); setServiceYearPart(parts.year);
  }
  function updateServiceMonthPart(part: "month" | "year", value: string) {
    const monthPart = part === "month" ? value : serviceMonthPart;
    const yearPart = part === "year" ? value : serviceYearPart;
    setServiceMonthPart(monthPart); setServiceYearPart(yearPart);
    setServiceMonth(combineServiceMonth(monthPart, yearPart));
  }
  async function openReview(row: Row, mode: "new" | "view" | "extend" = "new") {
    const viewOnly = mode === "view";
    previewAbort.current?.abort(); previewAbort.current = null; publishAbort.current?.abort(); publishAbort.current = null; previewGeneration.current++; previewSnapshot.current = null;
    setSelected(row); setReadOnly(viewOnly); setStep(viewOnly ? 0 : mode === "extend" ? 2 : 1); setChoice(mode === "extend" ? "existing" : "new"); setCanonicalId(mode === "extend" ? row.id : ""); setCanonicalRevision(mode === "extend" ? Number(row.revision || 0) : 0); setStudentIds([]); setPayerId(""); setPreview(null); setDetail(null); setTargetDetail(null); setError(""); setNotice("");
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const current = ++sequence.current, businessId = business.id;
    setBusy("Loading invoice details…");
    try {
      const result = await api(`${base}/invoices/${row.id}`, "GET", undefined, undefined, { signal: controller.signal, fresh: true });
      if (current !== sequence.current || scope.current !== businessId || controller.signal.aborted) return;
      const item: Detail = result.item || result;
      setDetail(item);
      if (mode === "extend") { setCanonicalId(item.invoice?.id || row.id); setCanonicalRevision(Number(item.invoice?.revision || row.revision || 0)); }
      setServiceMonthDraft(item.invoice?.serviceMonth || ""); setDueDate((item.invoice?.dueDate || "").slice(0, 10));
      setWorkFilter(uniqueInvoiceNames(item.invoice || row)[1] || uniqueInvoiceNames(item.invoice || row)[0] || "");
      const map: Record<string, string> = {};
      (item.work || []).forEach(work => { map[work.id] = work.linkedMinor ? String(work.linkedMinor / currencyScale(work.currency || item.invoice?.currency).scale) : ""; });
      setWorkLinks(map);
      const ids = (item.students || []).map(student => student.id).filter(Boolean);
      setStudentIds(ids); setPayerId(item.payers?.[0]?.id || "");
    } catch (reason) { if (current === sequence.current && !controller.signal.aborted) setError(errorMessage(reason)); }
    finally { if (current === sequence.current) setBusy(""); }
  }
  async function chooseCanonicalInvoice(id: string) {
    request.current?.abort();
    const current = ++sequence.current;
    setTargetDetail(null); setError("");
    if (!id) {
      setBusy("");
      setCanonicalId(""); setCanonicalRevision(0);
      setStudentIds((detail?.students || []).map(student => student.id).filter(Boolean)); setPayerId(detail?.payers?.[0]?.id || "");
      setServiceMonthDraft(detail?.invoice?.serviceMonth || ""); setDueDate((detail?.invoice?.dueDate || "").slice(0, 10));
      const map: Record<string, string> = {};
      (detail?.work || []).forEach(work => { map[work.id] = linkedWorkMinor(work) ? String(linkedWorkMinor(work) / currencyScale(work.currency || invoice.currency).scale) : ""; });
      setWorkLinks(map); return;
    }
    const controller = new AbortController(); request.current = controller;
    const businessId = business.id;
    setCanonicalId(id); setCanonicalRevision(0); setBusy("Loading selected invoice links…");
    try {
      const result = await api(`${base}/invoices/${encodeURIComponent(id)}`, "GET", undefined, undefined, { signal: controller.signal, fresh: true });
      if (current !== sequence.current || scope.current !== businessId || controller.signal.aborted) return;
      const target: Detail = result.item || result;
      if (!target.invoice?.id || target.invoice.id !== id) throw new Error("The selected invoice could not be confirmed. Choose it again.");
      setTargetDetail(target); setCanonicalId(target.invoice.id); setCanonicalRevision(Number(target.invoice.revision || 0));
      setStudentIds([...new Set([...(detail?.students || []).map(student => student.id), ...(target.students || []).map(student => student.id)].filter(Boolean))]);
      setPayerId(target.payers?.[0]?.id || detail?.payers?.[0]?.id || "");
      setServiceMonthDraft(target.invoice.serviceMonth || detail?.invoice?.serviceMonth || "");
      setDueDate((target.invoice.dueDate || detail?.invoice?.dueDate || "").slice(0, 10));
      const map: Record<string, string> = {};
      (detail?.work || []).forEach(work => { map[work.id] = linkedWorkMinor(work) ? String(linkedWorkMinor(work) / currencyScale(work.currency || invoice.currency).scale) : ""; });
      (target.work || []).forEach(work => { if (linkedWorkMinor(work) > 0 || !map[work.id]) map[work.id] = linkedWorkMinor(work) ? String(linkedWorkMinor(work) / currencyScale(work.currency || invoice.currency).scale) : ""; });
      setWorkLinks(map);
    } catch (reason) {
      if (current === sequence.current && !controller.signal.aborted && scope.current === businessId) { setCanonicalId(""); setCanonicalRevision(0); setTargetDetail(null); setError(errorMessage(reason)); }
    } finally { if (current === sequence.current && scope.current === businessId) setBusy(""); }
  }
  function closeDetail() {
    request.current?.abort(); previewAbort.current?.abort(); previewAbort.current = null; publishAbort.current?.abort(); publishAbort.current = null; previewGeneration.current++; previewSnapshot.current = null; sequence.current++;
    setBusy(""); setSelected(null); setDetail(null); setTargetDetail(null); setPreview(null); setError(""); setReadOnly(false);
  }
  async function loadAccepted(offset = acceptedOffset) {
    const businessId = business.id;
    try { const result = await api(`${base}/invoices?state=accepted&limit=50&offset=${offset}`, "GET", undefined, undefined, { fresh: true }); if (scope.current === businessId) { setAcceptedInvoices(result.items || []); setAcceptedOffset(offset); setAcceptedTotal(result.total || 0); } }
    catch (reason) { if (scope.current === businessId) setError(errorMessage(reason)); }
  }
  useEffect(() => { if (choice === "existing" && !acceptedInvoices.length) void loadAccepted(); }, [choice]);
  async function loadReceipts(offset = receiptOffset) {
    const businessId = business.id;
    try { const result = await api(`${base}/receipts?limit=50&offset=${offset}`, "GET", undefined, undefined, { fresh: true }); if (scope.current === businessId) { setReceipts(result.items || []); setReceiptOffset(offset); setReceiptTotal(result.total || 0); } }
    catch (reason) { if (scope.current === businessId) setError(errorMessage(reason)); }
  }
  useEffect(() => { if (tab === "payments" && canRead) { void loadReceipts(); if (!acceptedInvoices.length) void loadAccepted(); } }, [tab, canRead, revision]);

  function makeDecision() {
    if (hasPartialServiceMonth(serviceMonthPart, serviceYearPart)) throw new Error("Choose both a service month and year, or leave both unselected.");
    const work = workRows.flatMap(row => {
      const amount = workLinks[row.id];
      if (!amount) {
        if (linkedWorkMinor(row) > 0) throw new Error(`Keep the saved coverage for ${row.studentName || "this work row"} above zero, or enter a smaller positive amount.`);
        return [];
      }
      const amountMinor = decimalMinor(amount, row.currency || invoice.currency), availableMinor = availableWorkMinor(row);
      if (amountMinor <= 0 || amountMinor > availableMinor) throw new Error(`The amount for ${row.studentName || "this work row"} must be positive and no more than ${formatMinor(availableMinor, row.currency || invoice.currency)}.`);
      return [{ workId: row.id, revision: row.revision, amountMinor }];
    });
    return {
      source: { kind: source.kind || selected?.origin || selected?.sourceKind || "imported", id: source.id || selected?.sourceId || selected?.id, revision: source.revision || selected?.sourceRevision || selected?.revision },
      choice,
      ...(choice === "existing" ? { invoiceId: canonicalId, invoiceRevision: canonicalRevision } : {}),
      studentIds, payerId: payerId || null, serviceMonth: serviceMonth || null, dueDate: dueDate || null, workLinks: work, confirmed: true,
    };
  }
  function invalidatePreview() {
    previewAbort.current?.abort(); previewAbort.current = null; previewGeneration.current++; previewSnapshot.current = null; setPreview(null);
  }
  async function runPreview() {
    if (busy || !selected) return;
    previewAbort.current?.abort();
    const controller = new AbortController(), generation = ++previewGeneration.current, businessId = business.id, selectedId = selected.id;
    previewAbort.current = controller;
    setBusy("Preparing preview…"); setError(""); setPreview(null); previewSnapshot.current = null;
    try {
      const decision = makeDecision();
      if (!decision.source.id || !decision.source.revision) throw new Error("This invoice is missing its source version. Refresh the list and try again.");
      const snapshot = createPreviewSnapshot(decision, businessId, selectedId, generation);
      previewSnapshot.current = snapshot;
      const result = await api(`${base}/preview`, "POST", snapshot.decision, undefined, { signal: controller.signal });
      if (!previewScopeIsCurrent(snapshot, { businessId: scope.current, invoiceId: selected?.id || "", generation: previewGeneration.current, aborted: controller.signal.aborted })) return;
      const previewResult = result.item || result;
      const guards = previewInvoiceGuards(previewResult), publishSnapshot = createPublishSnapshot(snapshot, guards);
      previewSnapshot.current = { ...snapshot, preview: previewResult, publishDecision: publishSnapshot.decision };
      setPreview(previewResult); setStep(4);
    } catch (reason) { if (!controller.signal.aborted && scope.current === businessId && previewGeneration.current === generation) setError(errorMessage(reason)); }
    finally { if (scope.current === businessId && previewGeneration.current === generation) { setBusy(""); if (previewAbort.current === controller) previewAbort.current = null; } }
  }
  async function publish() {
    const snapshot = previewSnapshot.current;
    if (!preview || !snapshot?.preview || !snapshot.publishDecision || busy || !selected || !previewScopeIsCurrent(snapshot, { businessId: scope.current, invoiceId: selected.id, generation: previewGeneration.current })) { setError("This preview is no longer current. Review the details and prepare a new preview."); return; }
    setBusy("Saving your reviewed invoice…"); setError("");
    const businessId = business.id, controller = new AbortController(); publishAbort.current?.abort(); publishAbort.current = controller;
    const decision = snapshot.publishDecision, fingerprint = `invoice-publish:${JSON.stringify(decision)}`;
    const key = stableRetryKey(retryKeys.current, fingerprint, "invoice-publish", uuid);
    try {
      const result = await api(`${base}/publish`, "POST", decision, key, { signal: controller.signal });
      if (scope.current !== businessId || controller.signal.aborted || previewSnapshot.current !== snapshot && previewSnapshot.current?.generation !== snapshot.generation) return;
      setNotice(result.item?.alreadyPublished ? "This review was already saved." : "Invoice review saved.");
      retryKeys.current.delete(fingerprint); previewSnapshot.current = null; setSelected(null); setDetail(null); setPreview(null); setRevision(value => value + 1); onChanged?.();
    } catch (reason) { if (scope.current === businessId && !controller.signal.aborted) setError(errorMessage(reason)); }
    finally { if (scope.current === businessId) { setBusy(""); if (publishAbort.current === controller) publishAbort.current = null; } }
  }
  async function syncReceipts() {
    const businessId = business.id; setBusy("Checking confirmed payments…"); setError("");
    try { const body = { limit: 50, offset: syncOffset, confirmed: true }, fingerprint = JSON.stringify(body); const key = stableRetryKey(retryKeys.current, fingerprint, "receipt-sync", uuid); const response = await api(`${base}/receipts/sync`, "POST", body, key), result = response.item || response; retryKeys.current.delete(fingerprint); if (scope.current !== businessId) return; setSyncHasMore(Boolean(result.hasMore)); setSyncOffset(nextReceiptOffset(result, syncOffset)); setNotice(`${result.imported ?? 0} confirmed payment${result.imported === 1 ? "" : "s"} added to the list.`); await loadReceipts(); setRevision(value => value + 1); onChanged?.(); }
    catch (reason) { if (scope.current === businessId) setError(errorMessage(reason)); }
    finally { if (scope.current === businessId) setBusy(""); }
  }
  async function publishAllocation(receipt: Row) {
    const businessId = business.id; setBusy("Saving payment match…"); setError("");
    try {
      if (!allocationInvoice || !allocationAmount.trim()) throw new Error("Choose an invoice and enter an amount.");
      const amountMinor = decimalMinor(allocationAmount, receipt.currency);
      if (amountMinor <= 0) throw new Error("Enter an amount greater than zero.");
      const body = { receiptId: receipt.id, invoiceId: allocationInvoice, amountMinor, currency: receipt.currency, confirmed: true }, fingerprint = JSON.stringify(body); const key = stableRetryKey(retryKeys.current, fingerprint, "receipt-allocation", uuid);
      await api(`${base}/allocations`, "POST", body, key); retryKeys.current.delete(fingerprint);
      if (scope.current !== businessId) return;
      setAllocating(null); setAllocationInvoice(""); setAllocationAmount(""); setNotice("Payment matched to the selected invoice."); await loadReceipts(); setRevision(value => value + 1); onChanged?.();
    } catch (reason) { if (scope.current === businessId) setError(errorMessage(reason)); }
    finally { if (scope.current === businessId) setBusy(""); }
  }
  async function publishAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!adjusting) return;
    const businessId = business.id;
    const form = new FormData(event.currentTarget);
    setBusy("Saving bookkeeping entry…"); setError("");
    try {
      const currency = adjusting.currency, kind = String(form.get("kind")), amountMinor = decimalMinor(String(form.get("amount") || ""), currency), receiptId = String(form.get("receiptId") || "");
      if (kind === "refund" && !receiptId) throw new Error("Choose the payment being refunded.");
      if (amountMinor <= 0) throw new Error("Enter an amount greater than zero.");
      const body = { invoiceId: adjusting.id, kind, ...(kind === "refund" ? { receiptId } : {}), amountMinor, currency, occurredOn: String(form.get("date")), reason: String(form.get("reason")), confirmed: true }, fingerprint = JSON.stringify(body); const key = stableRetryKey(retryKeys.current, fingerprint, "invoice-adjustment", uuid);
      await api(`${base}/adjustments`, "POST", body, key); retryKeys.current.delete(fingerprint);
      if (scope.current !== businessId) return;
      setAdjusting(null); setNotice("Bookkeeping entry saved. No payment or refund was sent."); setRevision(value => value + 1); onChanged?.();
    } catch (reason) { if (scope.current === businessId) setError(errorMessage(reason)); }
    finally { if (scope.current === businessId) setBusy(""); }
  }
  async function addHistoricalReceipt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget), currency = String(form.get("currency"));
    const businessId = business.id;
    setBusy("Saving historical payment record…"); setError("");
    try {
      const amountMinor = decimalMinor(String(form.get("amount") || ""), currency); if (amountMinor <= 0) throw new Error("Enter an amount greater than zero.");
      const body = { amountMinor, currency, paidOn: String(form.get("paidOn")), reference: String(form.get("reference") || ""), reason: String(form.get("reason") || ""), confirmed: true }, fingerprint = JSON.stringify(body);
      const key = stableRetryKey(retryKeys.current, fingerprint, "historical-receipt", uuid);
      await api(`${base}/receipts`, "POST", body, key); retryKeys.current.delete(fingerprint);
      if (scope.current !== businessId) return;
      setAddingHistorical(false); setNotice("Historical payment saved. It can now be matched to an invoice."); await loadReceipts(0); onChanged?.();
    } catch (reason) { if (scope.current === businessId) setError(errorMessage(reason)); }
    finally { if (scope.current === businessId) setBusy(""); }
  }

  if (!canRead) return <Empty>You do not have access to financial reconciliation.</Empty>;
  const content = <div className="reconciliation">
    <div className="reconciliation-tabs" role="tablist" aria-label="Reconciliation areas">
      <button role="tab" aria-selected={tab === "invoices"} onClick={() => setTab("invoices")}>Invoices</button>
      <button role="tab" aria-selected={tab === "payments"} onClick={() => setTab("payments")}>Payments</button>
    </div>
    <Notice error={error} message={notice} />
    {!canWrite && <p className="reconciliation-note">You can review saved invoice and payment links. Ask a business administrator for permission to change them.</p>}
    {tab === "invoices" && <>
      {!selected ? <>
        <div className="reconciliation-toolbar"><div className="reconciliation-states"><button aria-pressed={listState === "unresolved"} onClick={() => setListState("unresolved")}>Needs review</button><button aria-pressed={listState === "accepted"} onClick={() => setListState("accepted")}>Reviewed</button></div><label><Search size={15}/><input aria-label="Search invoices to reconcile" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search invoices" /></label><button disabled={loading} aria-label="Refresh invoices" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15}/></button></div>
        {loading && <p role="status">Loading invoices…</p>}
        {!loading && !rows.length ? <Empty>{listState === "unresolved" ? "There are no invoices waiting for review." : "No reviewed invoices found."}</Empty> : <div className="reconciliation-list">{rows.map(row => <article key={row.id}>
          <div><strong>{row.invoiceNumber || row.number || row.fileName || `Invoice ${String(row.id).slice(0, 8)}`}</strong><span>{[...uniqueInvoiceNames(row), row.invoiceDate?.slice(0, 10) || row.date?.slice(0, 10)].filter(Boolean).join(" · ") || "Identity not yet reviewed"}</span></div>
          <div><strong>{formatMinor(detailAmount(row), row.currency || "EUR")}</strong><span>{row.status || (listState === "unresolved" ? "Needs review" : "Reviewed")}{row.serviceMonth ? ` · covers ${row.serviceMonth}` : ""}</span></div>
          <div className="reconciliation-row-actions"><button disabled={Boolean(busy)} onClick={() => void openReview(row, listState === "accepted" ? canWrite ? "extend" : "view" : "new")}>{listState === "unresolved" ? "Review invoice" : canWrite ? "Add or review links" : "View saved links"}<ChevronRight size={15}/></button>{listState === "accepted" && canWrite && <button disabled={Boolean(busy)} onClick={() => {setAdjusting(row); void loadReceipts(0);}}>Add credit or refund</button>}</div>
        </article>)}</div>}
        <div className="reconciliation-pagination"><span>{total ? `${page * 50 + 1}–${Math.min(page * 50 + rows.length, total)} of ${total} invoices` : "0 invoices"}</span><button disabled={page === 0 || loading} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button><button disabled={loading || (page + 1) * 50 >= total} onClick={() => setPage(value => value + 1)}>More invoices</button></div>
      </> : <>
        <div className="reconciliation-review-heading"><button disabled={Boolean(busy) && busy !== "Preparing preview…"} onClick={closeDetail}><ChevronLeft size={15}/>All invoices</button><span>{readOnly ? "Reviewed invoice" : `Review step ${step} of 4`}</span></div>
        {busy && <p role="status">{busy}</p>}
        {detail && <>
          <section className="reconciliation-source"><strong>{invoice.invoiceNumber || invoice.number || selected.invoiceNumber || selected.fileName || "Invoice evidence"}</strong><span>{formatMinor(detailAmount(invoice) || detailAmount(selected), invoice.currency || selected.currency || "EUR")} · {invoice.currency || selected.currency || "EUR"}</span><small>Original document and invoice history stay saved.</small></section>
          {(savedStudentRows.length || savedPayerRows.length || workRows.some(row => linkedWorkMinor(row) > 0) || invoiceReceipts.length) ? <section className="reconciliation-saved-links"><h4>Links already on this invoice</h4>{savedStudentRows.length ? <p><strong>Students:</strong> {savedStudentRows.map(student => linkedLabel(student, "student")).join(", ")}</p> : null}{savedPayerRows.length ? <p><strong>Payer:</strong> {savedPayerRows.map(payer => linkedLabel(payer, "payer")).join(", ")}</p> : null}{workRows.some(row => linkedWorkMinor(row) > 0) ? <p><strong>Covered work:</strong> {workRows.filter(row => linkedWorkMinor(row) > 0).length} work record{workRows.filter(row => linkedWorkMinor(row) > 0).length === 1 ? "" : "s"}</p> : null}{invoiceReceipts.length ? <p><strong>Payment matches:</strong> {invoiceReceipts.map(receipt => `${formatMinor(receiptAllocatedMinor(receipt, reviewInvoice.id), receipt.currency)} matched · ${receipt.date?.slice(0, 10) || receipt.paidOn?.slice(0, 10) || "date unavailable"}${receipt.evidence === "historical" ? " · historical record (already received)" : ""}`).join("; ")}</p> : null}</section> : null}
          {!readOnly && step === 2 && choice === "existing" && targetDetail?.invoice?.id === canonicalId && <p className="reconciliation-note">This invoice is already reviewed. Existing student, payer, and work links stay in place; you can add links or adjust saved work coverage.</p>}
          {readOnly && <section className="reconciliation-step"><h3>Reviewed links</h3>{savedStudentRows.length ? <p><strong>Students:</strong> {savedStudentRows.map(student => linkedLabel(student, "student")).join(", ")}</p> : <p>No student links are saved.</p>}{savedPayerRows.length ? <p><strong>Payer:</strong> {savedPayerRows.map(payer => linkedLabel(payer, "payer")).join(", ")}</p> : <p>No payer link is saved.</p>}{workRows.some(row => linkedWorkMinor(row) > 0) ? <div className="reconciliation-work">{workRows.filter(row => linkedWorkMinor(row) > 0).map(row => <div className="reconciliation-work-row" key={row.id}><span><strong>{row.date?.slice(0,10) || "Work record"} · Source name: {row.studentName || "not provided"}</strong><small>{row.service || "Recorded work"} · {formatMinor(row.linkedMinor, row.currency)}</small></span></div>)}</div> : <p>No work coverage is saved.</p>}{invoiceReceipts.length ? <p><strong>Payment matches:</strong> {invoiceReceipts.map(receipt => `${formatMinor(receiptAllocatedMinor(receipt, reviewInvoice.id), receipt.currency)} matched · ${receipt.date?.slice(0,10) || receipt.paidOn?.slice(0,10) || "date unavailable"}${receipt.evidence === "historical" ? " · historical record (already received)" : ""}`).join("; ")}</p> : <p>No receipt matches are saved.</p>}<button onClick={closeDetail}>Done</button></section>}
          {!readOnly && step === 1 && <section className="reconciliation-step"><h3>Does this document describe an existing invoice or an additional invoice?</h3><p>Choose existing when this is another copy or record of an obligation already in the list.</p><label className="reconciliation-choice"><input type="radio" checked={choice === "new"} onChange={() => { setChoice("new"); void chooseCanonicalInvoice(""); }}/>This is an additional invoice</label><label className="reconciliation-choice"><input type="radio" checked={choice === "existing"} onChange={() => setChoice("existing")}/>This is the same invoice as an existing record</label>{choice === "existing" && <><label>Choose the existing invoice<select value={canonicalId} disabled={Boolean(busy)} onChange={event => void chooseCanonicalInvoice(event.target.value)}><option value="">Choose an invoice</option>{acceptedInvoices.filter(row => row.currency === (invoice.currency || selected.currency)).map(row => <option key={row.id} value={row.id}>{row.invoiceNumber || row.number || `Invoice ${row.id.slice(0, 8)}`} · {formatMinor(detailAmount(row), row.currency)}</option>)}</select></label>{acceptedTotal > 50 && <div className="reconciliation-pagination"><button disabled={acceptedOffset === 0 || Boolean(busy)} onClick={() => void loadAccepted(Math.max(0, acceptedOffset - 50))}>Previous invoices</button><button disabled={acceptedOffset + 50 >= acceptedTotal || Boolean(busy)} onClick={() => void loadAccepted(acceptedOffset + 50)}>More invoices</button></div>}</>}</section>}
          {!readOnly && step === 2 && <section className="reconciliation-step"><h3>Who is responsible, and whose work does it cover?</h3><p>Choose payer and students separately. A name printed on an invoice is a clue, not a verified link. Existing links stay saved while you add more.</p>
            <label>Find students<input value={studentQuery} onChange={event => setStudentQuery(event.target.value)} placeholder="Search CRM students" disabled={!canReadClients || Boolean(busy)}/></label>{!canReadClients && <small>CRM student access is not available for this account.</small>}
            <div className="reconciliation-candidates">{students.map(candidate => <label key={candidate.id}><input type="checkbox" disabled={savedStudentIds.has(candidate.id) || Boolean(busy)} checked={studentIds.includes(candidate.id)} onChange={event => setStudentIds(current => event.target.checked ? [...current, candidate.id] : current.filter(id => id !== candidate.id))}/>{displayName(candidate)}{savedStudentIds.has(candidate.id) ? " · already linked" : ""}</label>)}{studentIds.filter(id => !students.some(candidate => candidate.id === id)).map(id => <label key={id}><input type="checkbox" checked disabled/>Previously linked student · {canonicalNames[id] || id.slice(0, 8)}</label>)}</div>
            <label>Find payer separately<input value={payerQuery} onChange={event => setPayerQuery(event.target.value)} placeholder="Search CRM payers" disabled={!canReadClients || Boolean(busy)}/></label><select aria-label="Choose invoice payer" value={payerId} disabled={!canReadClients || Boolean(busy) || Boolean(savedPayerId)} onChange={event => setPayerId(event.target.value)}><option value="">No payer selected</option>{payers.map(candidate => <option key={candidate.id} value={candidate.id}>{displayName(candidate)}</option>)}{payerId && !payers.some(candidate => candidate.id === payerId) && <option value={payerId}>Previously linked payer · {payerId.slice(0,8)}</option>}</select>{savedPayerId && <small>The saved payer stays linked.</small>}
          </section>}
          {!readOnly && step === 3 && <section className="reconciliation-step"><h3>Choose work covered by this invoice</h3><p>Only checked work is included. Enter a lower amount to cover part of a work row. Unchecked work keeps its current status.</p><small>Showing recent work records, with saved links first (up to 200 per invoice) in {invoice.currency || selected.currency}.</small>
            <div className="reconciliation-work-filter"><label>Filter by source student or payer<input value={workFilter} onChange={event => setWorkFilter(event.target.value)} placeholder="Search source names" disabled={Boolean(busy)}/></label>{workFilter && <button type="button" disabled={Boolean(busy)} onClick={() => setWorkFilter("")}>Show all recent records</button>}</div>
            <p className="reconciliation-work-summary" aria-live="polite">Selected coverage: {workSummary.count} work record{workSummary.count === 1 ? "" : "s"} · {formatMinor(workSummary.amountMinor, invoice.currency || selected.currency)}{workSummary.hasInvalidAmount ? " · Check selected amounts" : ""}</p>
            <div className="reconciliation-month-picker"><label>Service month<select aria-label="Service month" value={serviceMonthPart} onChange={event => updateServiceMonthPart("month", event.target.value)} disabled={Boolean(busy) || serviceMonthLocked}><option value="">Choose month</option>{Array.from({ length: 12 }, (_, index) => { const value = String(index + 1).padStart(2, "0"); return <option key={value} value={value}>{new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2020, index, 1)))}</option>; })}</select></label><label>Service year<select aria-label="Service year" value={serviceYearPart} onChange={event => updateServiceMonthPart("year", event.target.value)} disabled={Boolean(busy) || serviceMonthLocked}><option value="">Choose year</option>{serviceYears.map(year => <option key={year} value={year}>{year}</option>)}</select></label></div><small>Choose both to set a service period; leave both blank if it is unknown.</small>{serviceMonthLocked && <small>Saved service month {serviceMonth} is preserved on this invoice.</small>}<label>Due date<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} disabled={Boolean(busy)}/></label>
            {visibleWorkRows.length ? <div className="reconciliation-work">{visibleWorkRows.map(row => <label className="reconciliation-work-row" key={row.id}><input type="checkbox" disabled={availableWorkMinor(row) <= 0 || linkedWorkMinor(row) > 0 || Boolean(busy)} checked={Boolean(workLinks[row.id]) || linkedWorkMinor(row) > 0} onChange={event => setWorkLinks(current => ({...current, [row.id]: event.target.checked ? String(defaultWorkLinkMinor(row) / currencyScale(row.currency || invoice.currency).scale) : ""}))}/><span><strong>{row.date?.slice(0,10) || row.serviceDate?.slice(0,10) || "Work row"} · Source name: {row.studentName || "not provided"}</strong><small>{row.service || row.serviceType || "Recorded work"} · {formatMinor(row.amountMinor, row.currency || invoice.currency)}{linkedWorkMinor(row) ? ` · already covered on this invoice ${formatMinor(row.linkedMinor, row.currency || invoice.currency)}` : row.coveredMinor ? ` · other invoices cover ${formatMinor(row.coveredMinor, row.currency || invoice.currency)}` : ""}</small></span>{(workLinks[row.id] || linkedWorkMinor(row) > 0) && <input aria-label={`Amount covered for ${row.studentName || "work"}`} inputMode="decimal" value={workLinks[row.id] || String(linkedWorkMinor(row) / currencyScale(row.currency || invoice.currency).scale)} onChange={event => setWorkLinks(current => ({...current, [row.id]: event.target.value}))} disabled={Boolean(busy)}/>}</label>)}</div> : <p className="reconciliation-empty-work">{workRows.length ? "No recent work records match this filter." : "No work rows are available to link. You can still review the invoice."}</p>}
          </section>}
          {!readOnly && step === 4 && preview && <section className="reconciliation-step"><h3>Check the effect before saving</h3><p>No totals change until you publish this review.</p><div className="reconciliation-review-summary"><h4>What you selected</h4><p><strong>Students:</strong> {studentIds.length ? studentIds.map(id => canonicalNames[id] || students.find(candidate => candidate.id === id)?.displayName || students.find(candidate => candidate.id === id)?.name || `Linked student ID ${id.slice(0, 8)}`).join(", ") : "None"}</p><p><strong>Payer:</strong> {payerId ? canonicalNames[payerId] || payers.find(candidate => candidate.id === payerId)?.displayName || payers.find(candidate => candidate.id === payerId)?.name || `Linked payer ID ${payerId.slice(0, 8)}` : "None"}</p><p><strong>Service month:</strong> {serviceMonth || "Not set"} · <strong>Due date:</strong> {dueDate || "Not set"}</p><p><strong>Work coverage:</strong> {workSummary.count} record{workSummary.count === 1 ? "" : "s"} · {formatMinor(workSummary.amountMinor, invoice.currency || selected.currency)}</p></div>{refreshedInvoices.length > 0 && <div className="reconciliation-affected"><strong>Other invoices with refreshed work</strong><ul>{refreshedInvoices.map(row => <li key={row.invoiceId}>{row.label} · {row.workCount} work record{row.workCount === 1 ? "" : "s"}</li>)}</ul><p>The totals below include these shared work updates. Invoice amounts and payment matches stay as recorded.</p></div>}<PreviewTotals data={preview}/><div className="reconciliation-confirm"><Check size={17}/><span>Invoice evidence remains available. Historical paid declarations describe past records; they do not send a charge or verify a payment.</span></div></section>}
          {!readOnly && <div className="reconciliation-actions">{step > 1 && <button disabled={Boolean(busy)} onClick={() => { invalidatePreview(); setStep(step - 1); }}>Back</button>}{step < 3 && <button className="primary" disabled={Boolean(busy) || (step === 1 && choice === "existing" && (!canonicalId || !canonicalRevision))} onClick={() => {setError(""); setStep(step + 1);}}>Continue<ChevronRight size={15}/></button>}{step === 3 && <button className="primary" disabled={Boolean(busy)} onClick={() => void runPreview()}>Preview changes<ChevronRight size={15}/></button>}{step === 4 && <><button disabled={Boolean(busy)} onClick={() => {invalidatePreview();setStep(3);}}>Edit review</button><button className="primary" disabled={Boolean(busy) || !canWrite || !previewSnapshot.current?.preview} onClick={() => void publish()}>{busy || "Save reviewed invoice"}</button></>}</div>}
        </>}
      </>}
    </>}
    {tab === "payments" && <>
      <div className="reconciliation-payment-heading"><div><h3>Confirmed payments</h3><p>Payments already received can be linked to one or more invoices. Matching does not move money.</p></div><button disabled={!canWrite || Boolean(busy)} onClick={() => void syncReceipts()}><RefreshCw size={15}/>{syncHasMore ? "Check next page" : "Check for confirmed payments"}</button></div>
      {canWrite && <button className="reconciliation-secondary" disabled={Boolean(busy)} onClick={() => setAddingHistorical(true)}>Add a past payment record</button>}
      <div className="reconciliation-receipts">{receipts.map(receipt => <article key={receipt.id}><div><strong>{formatMinor(receipt.availableMinor ?? receipt.amountMinor, receipt.currency || "EUR")} available</strong><span>{receipt.date?.slice(0,10) || "Payment date unavailable"} · {receipt.provider || (receipt.evidence === "historical" ? "Historical record" : "Payment recorded")}</span><small>{receipt.evidence === "historical" ? "Historical declaration, not a new payment." : receiptIsSimulated(receipt) ? "Test payment, not a real collection." : "Confirmed payment evidence."}</small></div><button disabled={!canWrite || Boolean(busy) || !(receipt.availableMinor ?? receipt.amountMinor)} onClick={() => {setAllocating(receipt);setAllocationInvoice("");setAllocationAmount("");}}>Match to invoice</button></article>)}{!receipts.length && <Empty>No payment evidence is available yet. You can check for confirmed payments above.</Empty>}</div>
      {receiptTotal > 50 && <div className="reconciliation-pagination"><span>{receiptOffset + 1}–{Math.min(receiptOffset + receipts.length, receiptTotal)} of {receiptTotal} payments</span><button disabled={!receiptOffset || Boolean(busy)} onClick={() => void loadReceipts(Math.max(0, receiptOffset - 50))}>Previous payments</button><button disabled={receiptOffset + 50 >= receiptTotal || Boolean(busy)} onClick={() => void loadReceipts(receiptOffset + 50)}>More payments</button></div>}
      {canWrite && <p className="reconciliation-note">Invoice credits and refunds are bookkeeping records only. Saving one will not send a refund.</p>}
      {syncHasMore && <p className="reconciliation-note">More confirmed payments are available. <button disabled={Boolean(busy)} onClick={() => void syncReceipts()}>Check next page</button></p>}
    </>}
    {allocating && <section className="reconciliation-inline-form"><h3>Match this payment</h3><p>Available: {formatMinor(allocating.availableMinor ?? allocating.amountMinor, allocating.currency || "EUR")}. Match it to one invoice at a time. You can return to use any remaining amount.</p><label>Invoice<select value={allocationInvoice} onChange={event => setAllocationInvoice(event.target.value)}><option value="">Choose an invoice</option>{acceptedInvoices.filter(row => row.currency === allocating.currency).map(row => <option key={row.id} value={row.id}>{row.invoiceNumber || row.number || `Invoice ${row.id.slice(0,8)}`} · balance {formatMinor(row.outstandingMinor ?? detailAmount(row), row.currency)}</option>)}</select></label>{acceptedTotal > 50 && <div className="reconciliation-pagination"><button disabled={acceptedOffset === 0} onClick={() => void loadAccepted(Math.max(0, acceptedOffset - 50))}>Previous invoices</button><button disabled={acceptedOffset + 50 >= acceptedTotal} onClick={() => void loadAccepted(acceptedOffset + 50)}>More invoices</button></div>}<label>Amount in {allocating.currency}<input aria-label="Payment amount to match" inputMode="decimal" placeholder="0.00" value={allocationAmount} onChange={event => setAllocationAmount(event.target.value)}/></label><div className="reconciliation-actions"><button disabled={Boolean(busy)} onClick={() => setAllocating(null)}>Cancel</button><button className="primary" disabled={Boolean(busy) || !allocationInvoice || !allocationAmount.trim()} onClick={() => void publishAllocation(allocating)}>Save payment match</button></div></section>}
    {addingHistorical && <section className="reconciliation-inline-form"><h3>Add a past payment record</h3><p>Use a bank statement or other evidence of a payment already received. This does not create a new charge or confirm a provider payment.</p><form onSubmit={event => void addHistoricalReceipt(event)}><label>Amount<input name="amount" required inputMode="decimal" placeholder="0.00"/></label><label>Currency<select name="currency" defaultValue="EUR">{[...new Set(["EUR", "GBP", "USD", "MAD", "CAD", ...currencies])].map(currency => <option key={currency}>{currency}</option>)}</select></label><label>Payment date<input name="paidOn" type="date" required/></label><label>Statement reference<input name="reference" maxLength={200}/></label><label>Evidence note<input name="reason" maxLength={500} required placeholder="For example, bank transfer shown on statement"/></label><div className="reconciliation-actions"><button type="button" disabled={Boolean(busy)} onClick={() => setAddingHistorical(false)}>Cancel</button><button className="primary" disabled={Boolean(busy)}>{busy || "Save historical payment"}</button></div></form></section>}
    {adjusting && <section className="reconciliation-inline-form"><h3>Record a credit or refund</h3><p>Bookkeeping only. This will not send a payment or refund.</p><form onSubmit={event => void publishAdjustment(event)}><label>Entry type<select name="kind" defaultValue="credit"><option value="credit">Credit the invoice</option><option value="refund">Record a refund already made</option></select></label><label>Amount ({adjusting.currency})<input name="amount" inputMode="decimal" required placeholder="0.00"/></label><label>Date<input name="date" type="date" required defaultValue={new Date().toISOString().slice(0,10)}/></label><label>Reason<textarea name="reason" required maxLength={500}/></label><label>Payment to mark as refunded<select name="receiptId"><option value="">Choose a confirmed payment</option>{receipts.filter(receipt => receipt.currency === adjusting.currency && receipt.allocations?.some((link: Row) => link.invoiceId === adjusting.id)).map(receipt => <option key={receipt.id} value={receipt.id}>{formatMinor(receipt.amountMinor, receipt.currency)} · {receipt.date?.slice(0,10) || receipt.confirmedAt?.slice(0,10)}</option>)}</select></label><div className="reconciliation-actions"><button type="button" disabled={Boolean(busy)} onClick={() => setAdjusting(null)}>Cancel</button><button className="primary" disabled={Boolean(busy)}>{busy || "Save bookkeeping entry"}</button></div></form></section>}
  </div>;

  if (selected) return <Modal title={readOnly ? "Reviewed invoice" : "Review invoice"} closable={!busy || busy === "Preparing preview…"} onClose={closeDetail}>
    {content}
  </Modal>;
  return onClose ? <Modal title="Reconcile invoices & payments" onClose={onClose}>{content}</Modal> : content;
}

function PreviewTotals({ data }: { data: Row }) {
  const combined = previewCurrencyRows(data);
  const measures = [
    ["workValueMinor", "Recorded work value", true], ["invoicedMinor", "Invoiced", true],
    ["recordedPaidMinor", "Recorded paid", true], ["verifiedReceivedMinor", "Verified received", true],
    ["outstandingMinor", "Outstanding", true], ["pendingMinor", "Pending", true], ["unsentMinor", "Unsent", true],
    ["unresolvedInvoices", "Invoices needing review", false], ["unallocatedReceipts", "Payments needing a match", false],
  ] as const;
  if (!combined.length) return <div className="reconciliation-preview"><Notice message={data.message || "Review the change details below before saving."}/>{data.summary && <pre>{typeof data.summary === "string" ? data.summary : JSON.stringify(data.summary, null, 2)}</pre>}</div>;
  return <div className="reconciliation-preview">{combined.map((row, index) => {
    const before = row.before || row.beforeTotals || {}, after = row.after || row.afterTotals || {}, currency = row.currency || "EUR";
    return <section key={`${currency}:${index}`}><h4>{currency}</h4><div className="reconciliation-before-after"><strong>Measure</strong><strong>Before</strong><strong>After</strong>{measures.map(([key, label, isMoney]) => {
      if (before[key] == null && after[key] == null) return null;
      const render = (value: unknown) => value == null ? "—" : isMoney ? formatMinor(value, currency) : Number(value).toLocaleString();
      return <span key={key} className="reconciliation-preview-row"><span>{label}</span><span>{render(before[key])}</span><span>{render(after[key])}</span></span>;
    })}</div></section>;
  })}</div>;
}
