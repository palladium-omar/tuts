import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileSpreadsheet,
  Upload,
} from "lucide-react";
import { Modal, Notice } from "../components/shared";
import {
  errorMessage,
  money,
  type Api,
  type Business,
  type Row,
} from "../lib/api";
import {
  canCommitHistory,
  currencySettings,
  currencySuggestion,
  effectiveMapping,
  freshImportOptions,
  historyFields,
  historyStatusName,
  matchingFields,
  observedStatuses,
} from "../lib/history-import";
import "./history-import.css";

export function HistoryImport({
  api,
  business,
  defaultKind,
  initialFile,
  onClose,
  onImported,
}: {
  api: Api;
  business: Business;
  defaultKind: string;
  initialFile?: File | null;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(initialFile || null),
    [preview, setPreview] = useState<Row | null>(null),
    [options, setOptions] = useState<Row>(() =>
      freshImportOptions(defaultKind),
    ),
    [step, setStep] = useState<"file" | "currency" | "review">("file"),
    [currency, setCurrency] = useState("EUR"),
    [useColumn, setUseColumn] = useState(false),
    [showAll, setShowAll] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [partial, setPartial] = useState(false),
    [accepted, setAccepted] = useState(false),
    [page, setPage] = useState(0);
  const started = useRef(false),
    request = useRef<AbortController | null>(null),
    sequence = useRef(0),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  useEffect(
    () => () => {
      sequence.current++;
      request.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (initialFile && !started.current) {
      started.current = true;
      void readFile(initialFile, freshImportOptions(defaultKind));
    }
    return () => {
      started.current = false;
    };
  }, [initialFile]);

  async function inspect(
    next: File,
    settings: Row,
    clear = false,
  ): Promise<Row | null> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++sequence.current;
    setFile(next);
    if (clear) setPreview(null);
    setBusy("Reading your file…");
    setError("");
    setAccepted(false);
    setPartial(false);
    setPage(0);
    setDirty(true);
    try {
      const form = new FormData();
      form.set("file", next);
      form.set("options", JSON.stringify(settings));
      const result = await api(
        "billing/v1/history-imports/preview",
        "POST",
        form,
        undefined,
        { signal: controller.signal },
      );
      if (current !== sequence.current) return null;
      const item = result.item;
      setPreview(item);
      // Store explicit corrections only. Detected matches and defaults stay owned by the parser.
      setOptions({
        ...settings,
        kind: item.kind,
        sheetName: item.sheetName || undefined,
      });
      setDirty(false);
      return item;
    } catch (e) {
      if (current === sequence.current && !controller.signal.aborted)
        setError(errorMessage(e));
      return null;
    } finally {
      if (current === sequence.current) setBusy("");
    }
  }
  async function readFile(next: File, settings: Row) {
    setStep("file");
    setShowAll(false);
    setOptions(settings);
    const item = await inspect(next, settings, true);
    if (!item) return;
    setCurrency(
      currencySuggestion(
        item,
        business.settings?.billing?.currency ||
          business.settings?.profile?.currency ||
          business.settings?.currency,
      ),
    );
    setUseColumn(Boolean(item.currencyColumn));
    if (item.kind === "archive") setStep("review");
    else setStep("currency");
  }
  async function confirmCurrency() {
    if (!file || !preview) return;
    const item = await inspect(
      file,
      currencySettings(options, preview, currency, useColumn),
    );
    if (item) setStep("review");
  }
  function correction(patch: Row) {
    setOptions((current) => ({ ...current, ...patch }));
    setDirty(true);
    setAccepted(false);
  }
  async function commit() {
    if (
      !preview ||
      !canCommitHistory(preview, {
        busy: Boolean(busy),
        dirty,
        accepted,
        partial,
      })
    )
      return;
    setBusy("Importing your history…");
    setError("");
    try {
      const result = await api(
        "billing/v1/history-imports/commit",
        "POST",
        { token: preview.token, allowPartial: partial },
        `history:${preview.token}`,
      );
      onImported(
        result.item?.alreadyCommitted
          ? "This file was already imported. No duplicate records were added."
          : `${result.item?.importedCount ?? result.item?.imported ?? preview.summary.valid} records imported. Your original file is saved.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  const mapping = preview ? effectiveMapping(preview, options) : {},
    groups = preview ? observedStatuses(preview) : [],
    allRows: Row[] = preview?.rows || [],
    visible = allRows.slice(page * 25, (page + 1) * 25),
    pages = Math.max(1, Math.ceil(allRows.length / 25)),
    isArchive = preview?.kind === "archive";
  const commonCurrencies = [
    "EUR",
    "GBP",
    "USD",
    "MAD",
    "CAD",
    "AUD",
    "CHF",
    "JPY",
    "AED",
  ];
  const currencies = Array.from(
    new Set([
      currency,
      ...commonCurrencies,
      ...(preview?.currencyVariants || []),
      ...Intl.supportedValuesOf("currency"),
    ]),
  ).sort();
  return (
    <Modal
      title="Import your history"
      onClose={() => {
        if (!busy || busy === "Reading your file…") {
          sequence.current++;
          request.current?.abort();
          onClose();
        }
      }}
    >
      <div className="history-import">
        <ol className="history-import-steps" aria-label="Import progress">
          {(["file", "currency", "review"] as const).map((value, index) => (
            <li
              key={value}
              aria-current={step === value ? "step" : undefined}
              className={step === value ? "active" : ""}
            >
              <span>
                {["file", "currency", "review"].indexOf(step) > index ? (
                  <Check size={14} />
                ) : (
                  index + 1
                )}
              </span>
              {["File", "Currency", "Review"][index]}
            </li>
          ))}
        </ol>
        <Notice error={error} />
        {busy && (
          <p role="status" className="history-import-loading">
            {busy}
          </p>
        )}
        {step === "file" && (
          <section className="history-import-question">
            <h3 ref={heading} tabIndex={-1}>
              What would you like to import?
            </h3>
            <p>
              Upload your hours tracker or past invoices. We’ll find the columns
              and keep the original file.
            </p>
            <label className="history-import-upload">
              <Upload size={26} />
              <strong>{file ? file.name : "Choose a file"}</strong>
              <span>Excel, CSV or PDF · up to 5 MB</span>
              <input
                type="file"
                accept=".csv,.xlsx,.pdf"
                disabled={Boolean(busy)}
                onChange={(event) => {
                  const next = event.target.files?.[0];
                  if (next)
                    void readFile(next, freshImportOptions(defaultKind));
                  event.target.value = "";
                }}
              />
            </label>
            {error && file && (
              <button
                disabled={Boolean(busy)}
                onClick={() =>
                  void readFile(file, freshImportOptions(defaultKind))
                }
              >
                Try reading again
              </button>
            )}
          </section>
        )}
        {step === "currency" && preview && (
          <section className="history-import-question">
            <span className="history-import-file">
              <FileSpreadsheet size={18} />
              {file?.name}
            </span>
            <h3 ref={heading} tabIndex={-1}>
              Which currency are these amounts in?
            </h3>
            <p>
              {preview.detectedCurrency
                ? `We found ${preview.detectedCurrency} in your amount columns. Confirm it below.`
                : preview.currencyColumn
                  ? "Your file has a currency column. Use it for each row, or choose one currency for the whole file."
                  : "Choose once for this import. It will apply to every amount in the file."}
            </p>
            {preview.currencyColumn && (
              <label className="history-import-check">
                <input
                  type="checkbox"
                  checked={useColumn}
                  disabled={Boolean(busy)}
                  onChange={(e) => setUseColumn(e.target.checked)}
                />
                <span>
                  Use currencies in the “{preview.currencyColumn}” column
                  {preview.currencyVariants?.length > 0
                    ? ` (${preview.currencyVariants.join(", ")})`
                    : ""}
                </span>
              </label>
            )}
            <label className="history-import-currency">
              {useColumn ? "Currency for rows with no currency" : "Currency"}
              <select
                value={currency}
                disabled={Boolean(busy)}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencies.map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </label>
            {preview.sheets?.length > 1 && (
              <label className="history-import-currency">
                Import this sheet
                <select
                  value={preview.sheetName}
                  disabled={Boolean(busy)}
                  onChange={(e) => {
                    if (file)
                      void readFile(
                        file,
                        freshImportOptions(options.kind, e.target.value),
                      );
                  }}
                >
                  {preview.sheets.map((sheet: Row) => (
                    <option key={sheet.name} value={sheet.name}>
                      {sheet.name} · {sheet.rowCount} rows
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="form-actions">
              <button disabled={Boolean(busy)} onClick={() => setStep("file")}>
                <ArrowLeft size={16} />
                Back
              </button>
              <button
                className="primary"
                disabled={Boolean(busy)}
                onClick={() => void confirmCurrency()}
              >
                Review import
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}
        {step === "review" && preview && (
          <>
            <h3 ref={heading} tabIndex={-1}>
              {isArchive ? "Save your original file" : "Here’s what we found"}
            </h3>
            <div className="history-import-summary">
              <div>
                <strong>{file?.name}</strong>
                <span>
                  {preview.sheetName || "Original document"}
                  {!isArchive &&
                    ` · ${useColumn ? "Currencies from file" : options.currency}`}
                </span>
              </div>
              {!isArchive && (
                <button
                  disabled={Boolean(busy)}
                  onClick={() => setStep("currency")}
                >
                  Change currency or sheet
                </button>
              )}
            </div>
            {!isArchive && (
              <>
                <div className="history-import-counts">
                  <span>
                    <strong>{preview.summary.valid}</strong> ready
                  </span>
                  {preview.summary.invalid > 0 && (
                    <span className="history-import-attention">
                      <strong>{preview.summary.invalid}</strong> need attention
                    </span>
                  )}
                  {preview.summary.skipped > 0 && (
                    <span>
                      {preview.summary.skipped} empty or summary rows skipped
                    </span>
                  )}
                </div>
                <section
                  className="history-import-statuses"
                  aria-label="Detected payment statuses"
                >
                  <h4>Payment statuses</h4>
                  <p>
                    Capitalization and extra spaces are handled automatically.
                  </p>
                  {groups.length ? (
                    groups.map((group) => {
                      const status =
                        options.statusMap?.[group.key] ?? group.status;
                      return (
                        <div
                          className={`history-import-status ${!status ? "needs-review" : ""}`}
                          key={group.key}
                        >
                          <div>
                            <strong>
                              {group.labels
                                .map((label: string) => label.trim())
                                .filter(
                                  (
                                    label: string,
                                    index: number,
                                    labels: string[],
                                  ) => labels.indexOf(label) === index,
                                )
                                .join(" / ") || "Blank"}
                            </strong>
                            <span>
                              {group.count} {group.count === 1 ? "row" : "rows"}{" "}
                              → {historyStatusName(status || "")}
                            </span>
                          </div>
                          {!status ? (
                            <label>
                              What does this mean?
                              <select
                                value={status || ""}
                                disabled={Boolean(busy)}
                                onChange={(e) =>
                                  correction({
                                    statusMap: {
                                      ...options.statusMap,
                                      [group.key]: e.target.value,
                                    },
                                  })
                                }
                              >
                                <option value="">Choose a meaning</option>
                                {["unsent", "pending", "paid"].map((s) => (
                                  <option value={s} key={s}>
                                    {historyStatusName(s)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <details>
                              <summary>Change</summary>
                              <label>
                                Meaning
                                <select
                                  value={status}
                                  disabled={Boolean(busy)}
                                  onChange={(e) =>
                                    correction({
                                      statusMap: {
                                        ...options.statusMap,
                                        [group.key]: e.target.value,
                                      },
                                    })
                                  }
                                >
                                  {["unsent", "pending", "paid"].map((s) => (
                                    <option value={s} key={s}>
                                      {historyStatusName(s)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </details>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <p>
                      No payment status values found. Check the column matches
                      below.
                    </p>
                  )}
                </section>
                <details className="history-import-matching">
                  <summary>Check or change column matches</summary>
                  <p>
                    We detected these automatically. Only change a match if it’s
                    wrong.
                  </p>
                  <div className="form-grid">
                    {matchingFields(preview, options, showAll).map((key) => (
                      <label key={key}>
                        {historyFields[key]}
                        <select
                          value={mapping[key] || ""}
                          disabled={Boolean(busy)}
                          onChange={(e) =>
                            correction({
                              mapping: {
                                ...options.mapping,
                                [key]: e.target.value,
                              },
                            })
                          }
                        >
                          <option value="">
                            {[
                              "date",
                              "studentName",
                              "hours",
                              "amountMinor",
                              "status",
                            ].includes(key)
                              ? "Choose a column"
                              : "Not used"}
                          </option>
                          {preview.headers.map((header: string) => (
                            <option key={header}>{header}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <button
                    className="history-import-text-button"
                    onClick={() => setShowAll(!showAll)}
                  >
                    {showAll
                      ? "Show detected columns"
                      : "Show optional columns"}
                  </button>
                  <label>
                    Import as
                    <select
                      value={options.kind}
                      disabled={Boolean(busy)}
                      onChange={(e) => {
                        if (file)
                          void inspect(file, {
                            ...freshImportOptions(
                              e.target.value,
                              preview.sheetName,
                            ),
                            currency: options.currency,
                            ...(options.mapping?.currency !== undefined
                              ? {
                                  mapping: {
                                    currency: options.mapping.currency,
                                  },
                                }
                              : {}),
                          });
                      }}
                    >
                      <option value="work">Work and hours</option>
                      <option value="invoices">Past invoices</option>
                      <option value="archive">Original file only</option>
                    </select>
                  </label>
                  {preview.kind === "work" && (
                    <label className="history-import-check">
                      <input
                        type="checkbox"
                        checked={Boolean(options.countAsClasses)}
                        disabled={Boolean(busy)}
                        onChange={(e) =>
                          correction({ countAsClasses: e.target.checked })
                        }
                      />
                      <span>
                        Each row represents one class. Include it in
                        class-frequency statistics.
                      </span>
                    </label>
                  )}
                </details>
                {dirty && (
                  <div className="history-import-recheck">
                    <span>Your changes need a fresh preview.</span>
                    <button
                      className="primary"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (file) void inspect(file, options);
                      }}
                    >
                      Update preview
                    </button>
                  </div>
                )}
                {preview.warnings?.length > 0 && (
                  <details className="history-import-notes">
                    <summary>Import notes ({preview.warnings.length})</summary>
                    <ul>
                      {preview.warnings.map((warning: string, i: number) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <div
                  className="history-import-table"
                  aria-label="Import row preview"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Student</th>
                        <th>Date</th>
                        <th>{preview.kind === "work" ? "Hours" : "Invoice"}</th>
                        <th>Amount</th>
                        <th>Status / review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((row) => (
                        <tr
                          key={row.rowNumber}
                          className={row.errors.length ? "needs-review" : ""}
                        >
                          <td>{row.rowNumber}</td>
                          <td>{row.values.studentName || "—"}</td>
                          <td>{row.values.date || "—"}</td>
                          <td>
                            {preview.kind === "work"
                              ? (row.values.hours ?? "—")
                              : row.values.invoiceNumber || "—"}
                          </td>
                          <td>
                            {row.values.amountMinor != null &&
                            row.values.currency
                              ? money(
                                  row.values.amountMinor,
                                  row.values.currency,
                                )
                              : "—"}
                          </td>
                          <td>
                            {historyStatusName(row.values.status || "")}
                            {[...row.errors, ...row.warnings].map(
                              (note: string, index: number) => (
                                <small key={index}>{note}</small>
                              ),
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pages > 1 && (
                  <div className="history-import-pagination">
                    <button
                      disabled={page === 0}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      Page {page + 1} of {pages}
                    </span>
                    <button
                      disabled={page + 1 === pages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
                {preview.summary.invalid > 0 && (
                  <label className="history-import-check">
                    <input
                      type="checkbox"
                      checked={partial}
                      disabled={Boolean(busy) || dirty}
                      onChange={(e) => {
                        setPartial(e.target.checked);
                        setAccepted(false);
                      }}
                    />
                    <span>
                      Import only the {preview.summary.valid} ready rows. The{" "}
                      {preview.summary.invalid} rows needing attention stay in
                      the original file for review.
                    </span>
                  </label>
                )}
              </>
            )}
            {isArchive && (
              <p>
                This document will be saved for reference. No work or payment
                records will be created.
              </p>
            )}
            <label className="history-import-check">
              <input
                type="checkbox"
                checked={accepted}
                disabled={Boolean(busy) || dirty}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                {isArchive
                  ? "Save this file for reference."
                  : "I’ve checked the amounts and payment statuses."}
              </span>
            </label>
            <p className="history-import-footnote">
              Your original file and its columns are preserved. Importing
              history never charges a client or sends an invoice.
            </p>
            <div className="form-actions">
              <button disabled={Boolean(busy)} onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  !canCommitHistory(preview, {
                    busy: Boolean(busy),
                    dirty,
                    accepted,
                    partial,
                  })
                }
                onClick={() => void commit()}
              >
                {isArchive
                  ? "Save file"
                  : `Import ${preview.summary.valid} ${preview.summary.valid === 1 ? "record" : "records"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
