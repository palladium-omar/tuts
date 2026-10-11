import assert from "node:assert/strict";
import test from "node:test";
import {
  availableWorkMinor,
  affectedInvoiceSummaries,
  createPreviewSnapshot,
  createPublishSnapshot,
  combineServiceMonth,
  defaultWorkLinkMinor,
  linkedWorkMinor,
  hasPartialServiceMonth,
  nextReceiptOffset,
  previewCurrencyRows,
  previewInvoiceGuards,
  previewScopeIsCurrent,
  receiptAllocatedMinor,
  receiptIsSimulated,
  stableRetryKey,
  serviceMonthParts,
  serviceYearOptions,
  summarizeWorkLinks,
  uniqueInvoiceNames,
} from "../lib/reconciliation";

test("work review edits its own link without reattaching another invoice's coverage", () => {
  const unrelatedLink = { amountMinor: 10_000, coveredMinor: 6_000, linkedMinor: 0 };
  assert.equal(linkedWorkMinor(unrelatedLink), 0);
  assert.equal(availableWorkMinor(unrelatedLink), 4_000);
  assert.equal(defaultWorkLinkMinor(unrelatedLink), 4_000);

  const thisInvoiceLink = { amountMinor: 10_000, coveredMinor: 8_000, linkedMinor: 3_000 };
  assert.equal(linkedWorkMinor(thisInvoiceLink), 3_000);
  assert.equal(availableWorkMinor(thisInvoiceLink), 5_000);
  assert.equal(defaultWorkLinkMinor(thisInvoiceLink), 3_000);
  assert.equal(availableWorkMinor({ amountMinor: 10_000, coveredMinor: 10_000, linkedMinor: 0 }), 0);
});

test("preview totals pair before and after values separately for each currency", () => {
  const rows = previewCurrencyRows({
    before: [{ currency: "EUR", invoicedMinor: 100 }, { currency: "MAD", invoicedMinor: 200 }],
    after: [{ currency: "EUR", invoicedMinor: 150 }, { currency: "MAD", invoicedMinor: 200 }],
  });
  assert.deepEqual(rows.map(row => [row.currency, row.before.invoicedMinor, row.after.invoicedMinor]), [
    ["EUR", 100, 150], ["MAD", 200, 200],
  ]);
});

test("retry keys repeat only for the same outstanding request fingerprint", () => {
  const keys = new Map<string, string>(); let calls = 0;
  const nextId = () => `id-${++calls}`;
  const first = stableRetryKey(keys, "same-body", "allocation", nextId);
  assert.equal(stableRetryKey(keys, "same-body", "allocation", nextId), first);
  const changed = stableRetryKey(keys, "changed-body", "allocation", nextId);
  assert.notEqual(changed, first);
  keys.delete("same-body");
  assert.notEqual(stableRetryKey(keys, "same-body", "allocation", nextId), first);
});

test("receipt sync restarts on the next check after its final page", () => {
  assert.equal(nextReceiptOffset({ hasMore: true, nextOffset: 50 }, 0), 50);
  assert.equal(nextReceiptOffset({ hasMore: false, nextOffset: 23 }, 0), 0);
  assert.equal(receiptIsSimulated({ evidence: "simulated" }), true);
  assert.equal(receiptIsSimulated({ evidence: "provider_verified" }), false);
});

test("work summary counts selected rows and totals partial decimal coverage", () => {
  const rows = [
    { id: "work-a", currency: "EUR", amountMinor: 4_000, coveredMinor: 0, linkedMinor: 0 },
    { id: "work-b", currency: "EUR", amountMinor: 3_000, coveredMinor: 1_000, linkedMinor: 500 },
    { id: "work-c", currency: "EUR", amountMinor: 5_000, coveredMinor: 5_000, linkedMinor: 0 },
  ];
  assert.deepEqual(summarizeWorkLinks(rows, { "work-a": "12.50", "work-b": "5.00" }, "EUR"), {
    count: 2, amountMinor: 1_750, hasInvalidAmount: false,
  });
  assert.deepEqual(summarizeWorkLinks(rows, { "work-a": "0", "work-c": "1.00" }, "EUR"), {
    count: 1, amountMinor: 100, hasInvalidAmount: true,
  });
});

test("invoice payment summary uses only the amount matched to that invoice", () => {
  assert.equal(receiptAllocatedMinor({
    amountMinor: 8_000,
    allocatedMinor: 2_500,
    allocations: [{ invoiceId: "invoice-a", amountMinor: 8_000 }],
  }, "invoice-a"), 2_500);
  assert.equal(receiptAllocatedMinor({ amountMinor: 8_000, allocations: [
    { invoiceId: "invoice-a", amountMinor: 2_000 },
    { invoiceId: "invoice-b", amountMinor: 1_000 },
  ] }, "invoice-a"), 2_000);
});

test("invoice list names remove duplicate payer and student labels", () => {
  assert.deepEqual(uniqueInvoiceNames({ payerName: "Sample family", studentName: "Sample family", studentNames: ["Sample family", "Student two"] }), ["Sample family", "Student two"]);
});

test("preview captures an immutable decision and rejects stale invoice, tenant, generation, and aborted responses", () => {
  const decision = { source: { id: "source-one", revision: 4 }, studentIds: ["student-one"], workLinks: [{ workId: "work-one", amountMinor: 1_200 }] };
  const snapshot = createPreviewSnapshot(decision, "business-one", "invoice-one", 7);
  decision.source.revision = 5;
  decision.studentIds.push("student-two");
  assert.equal(snapshot.decision.source.revision, 4);
  assert.deepEqual(snapshot.decision.studentIds, ["student-one"]);
  assert.equal(Object.isFrozen(snapshot.decision), true);
  assert.equal(Object.isFrozen(snapshot.decision.source), true);
  const current = { businessId: "business-one", invoiceId: "invoice-one", generation: 7 };
  assert.equal(previewScopeIsCurrent(snapshot, current), true);
  assert.equal(previewScopeIsCurrent(snapshot, { ...current, invoiceId: "invoice-two" }), false);
  assert.equal(previewScopeIsCurrent(snapshot, { ...current, businessId: "business-two" }), false);
  assert.equal(previewScopeIsCurrent(snapshot, { ...current, generation: 8 }), false);
  assert.equal(previewScopeIsCurrent(snapshot, { ...current, aborted: true }), false);
});

test("preview captures revisions for every other affected invoice without changing the reviewed decision", () => {
  const preview = {
    invoiceId: "invoice-target",
    affectedInvoices: [
      { invoiceId: "invoice-target", revision: 8, workIds: ["work-one"] },
      { invoiceId: "invoice-other", revision: 12, workIds: ["work-one", "work-two"] },
    ],
    guards: { invoices: [{ invoiceId: "invoice-other", revision: 11 }] },
  };
  const guards = previewInvoiceGuards(preview);
  const original = createPreviewSnapshot({ source: { id: "source-one", revision: 3 }, workLinks: [{ workId: "work-one", amountMinor: 500 }] }, "business-one", "source-one", 2);
  const publish = createPublishSnapshot(original, guards);
  assert.equal("invoiceGuards" in original.decision, false);
  assert.deepEqual(original.decision.workLinks, [{ workId: "work-one", amountMinor: 500 }]);
  assert.deepEqual(publish.decision.invoiceGuards, [{ invoiceId: "invoice-other", revision: 11 }]);
  assert.equal(Object.isFrozen(publish.decision.invoiceGuards), true);
  assert.throws(() => previewInvoiceGuards({ ...preview, guards: { invoices: [] } }), /Some linked invoices changed/);
  assert.deepEqual(affectedInvoiceSummaries(preview, [{ id: "invoice-other", invoiceNumber: "INV-42" }]), [
    { invoiceId: "invoice-other", label: "INV-42", workCount: 2 },
  ]);
  assert.deepEqual(affectedInvoiceSummaries({ ...preview, affectedInvoices: [preview.affectedInvoices[1]] }, []), [
    { invoiceId: "invoice-other", label: "Invoice invoice-", workCount: 2 },
  ]);
});

test("service month select parts preserve known historical years and combine only complete selections", () => {
  assert.deepEqual(serviceMonthParts("1984-02"), { year: "1984", month: "02" });
  assert.deepEqual(serviceMonthParts("not-known"), { month: "", year: "" });
  assert.equal(combineServiceMonth("02", "1984"), "1984-02");
  assert.equal(combineServiceMonth("", "1984"), "");
  assert.equal(hasPartialServiceMonth("02", ""), true);
  assert.equal(hasPartialServiceMonth("02", "1984"), false);
  const years = serviceYearOptions(2026, "1999-04-10", "1984-02");
  assert.ok(years.includes("1999"));
  assert.ok(years.includes("1984"));
  assert.ok(years.includes("2026"));
});
