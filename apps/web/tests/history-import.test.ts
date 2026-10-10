import assert from "node:assert/strict";
import test from "node:test";
import {
  canCommitHistory,
  currencySettings,
  currencySuggestion,
  effectiveMapping,
  freshImportOptions,
  matchingFields,
  normalizeStatusLabel,
  observedStatuses,
} from "../lib/history-import";

test("status variants share a normalized label", () => {
  for (const label of [
    "Pending",
    " PENDING ",
    "pending",
    "\u00a0Pending\u00a0",
  ])
    assert.equal(normalizeStatusLabel(label), "pending");
  assert.equal(normalizeStatusLabel("Not_Sent"), "not sent");
  assert.equal(normalizeStatusLabel("not-sent"), "not sent");
});
test("only source statuses are presented; defaults are never questions", () => {
  const labels = [
    {
      key: "pending",
      labels: ["pending", "Pending"],
      count: 2,
      status: "pending",
    },
  ];
  assert.deepEqual(
    observedStatuses({
      statusLabels: labels,
      statusMap: { Paid: "paid", Pending: "pending", unsent: "unsent" },
    }),
    labels,
  );
  assert.deepEqual(observedStatuses({ statusMap: { Paid: "paid" } }), []);
});
test("currency is chosen once and only actual currency columns can be mapped", () => {
  assert.deepEqual(currencySettings({ kind: "work" }, {}, "EUR", false), {
    kind: "work",
    currency: "EUR",
    mapping: {},
  });
  assert.deepEqual(
    currencySettings(
      { mapping: { studentName: "Name" } },
      { currencyColumn: "Currency" },
      "GBP",
      false,
    ),
    { currency: "GBP", mapping: { studentName: "Name", currency: "" } },
  );
  assert.equal(
    currencySettings({}, { currencyColumn: "Currency" }, "EUR", true).mapping
      .currency,
    "Currency",
  );
  assert.equal(currencySuggestion({ detectedCurrency: "GBP" }, "EUR"), "GBP");
  assert.equal(currencySuggestion({ currencyVariants: ["CAD"] }, "EUR"), "CAD");
  assert.equal(currencySuggestion({}, "MAD"), "MAD");
});
test("only explicit corrections survive state; fresh files and sheets discard prior matching", () => {
  const preview = {
    kind: "work",
    mapping: { studentName: "Student Name", date: "Date" },
  };
  const options = { mapping: { studentName: "" } };
  assert.equal(effectiveMapping(preview, options).studentName, "");
  assert.deepEqual(freshImportOptions("auto", "HoursLog"), {
    kind: "auto",
    sheetName: "HoursLog",
    countAsClasses: false,
  });
  assert.ok(matchingFields(preview, options).includes("studentName"));
  assert.ok(!matchingFields(preview, options).includes("currency"));
  assert.ok(!matchingFields(preview, options, true).includes("currency"));
});

test("commit requires a current reviewed preview; partial import can skip unfamiliar statuses", () => {
  const preview = {
    token: "source",
    kind: "work",
    summary: { valid: 2, invalid: 1 },
  };
  const state = { busy: false, dirty: false, accepted: true, partial: false };
  assert.equal(canCommitHistory(preview, state), false);
  assert.equal(canCommitHistory(preview, { ...state, partial: true }), true);
  assert.equal(
    canCommitHistory(preview, { ...state, partial: true, dirty: true }),
    false,
  );
  assert.equal(
    canCommitHistory(preview, { ...state, partial: true, busy: true }),
    false,
  );
  assert.equal(
    canCommitHistory(preview, { ...state, partial: true, accepted: false }),
    false,
  );
  assert.equal(
    canCommitHistory(
      { ...preview, summary: { valid: 0, invalid: 1 } },
      { ...state, partial: true },
    ),
    false,
  );
  assert.equal(
    canCommitHistory(
      { ...preview, kind: "archive", summary: { valid: 0, invalid: 0 } },
      state,
    ),
    true,
  );
});
