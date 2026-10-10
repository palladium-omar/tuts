import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  FileText,
  Plus,
  Printer,
  Wallet,
  Copy,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  errorMessage,
  date,
  money,
  type Api,
  type Business,
  type Row,
} from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import "./teaching-ux.css";
import "./payments-ux.css";
function invoiceCycle(serviceMonth: string) {
  const [year, month] = serviceMonth.split("-").map(Number);
  return {
    period: new Date(Date.UTC(year, month - 1, 2)).toLocaleDateString(
      undefined,
      { month: "long", year: "numeric", timeZone: "UTC" },
    ),
    due: new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}
export function Invoices({ api, business }: { api: Api; business: Business }) {
  const [rows, setRows] = useState<Row[]>([]),
    [creating, setCreating] = useState(false),
    [invoice, setInvoice] = useState<Row | null>(null),
    [currency, setCurrency] = useState("USD"),
    [price, setPrice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  async function load() {
    setLoading(true);
    try {
      setRows((await api("billing/v1/invoices")).items);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [api]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const value = String(f.get("price"));
    if (!/^\d+(\.\d{1,2})?$/.test(value)) {
      setError("Enter an amount with up to two decimal places, such as 90.50.");
      return;
    }
    const [whole, fraction = ""] = value.split(".");
    const amountMinor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      setError("Enter a positive amount within the supported range.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api("billing/v1/invoices", "POST", {
        payerName: f.get("payerName"),
        currency: f.get("currency"),
        items: [
          {
            description: f.get("description"),
            quantity: 1,
            unitPriceMinor: amountMinor,
          },
        ],
      });
      setCreating(false);
      setInvoice(result.item);
      await load();
      setMessage("Draft invoice saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function issue(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api(`billing/v1/invoices/${id}/issue`, "POST", {});
      setInvoice(result.item);
      await load();
      setMessage("Invoice issued. It is ready to print or save as a PDF.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const seller =
    invoice?.sellerSnapshot ??
    (invoice?.status === "draft"
      ? {
          name: business.name,
          profile: business.settings.profile,
          branding: business.settings.branding,
        }
      : null);
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Invoices that look like your business.</h1>
          <p className="muted">
            Your saved logo, business address, and contact details are reused
            automatically.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setError("");
            setMessage("");
            setPrice("");
            setCurrency("USD");
            setCreating(true);
          }}
        >
          <Plus size={16} />
          New invoice
        </button>
      </div>
      <Notice
        error={!creating && !invoice ? error : ""}
        message={!invoice ? message : ""}
      />
      <section className="panel">
        <div className="panel-title">
          <h3>Your invoices</h3>
          <span className="tag">
            {rows.length} {rows.length === 1 ? "invoice" : "invoices"}
          </span>
        </div>
        {loading && !rows.length ? (
          <Empty>Loading invoices…</Empty>
        ) : !rows.length ? (
          <Empty>
            <FileText size={30} />
            <h3>Your first invoice starts here.</h3>
            <p>
              Create a draft, review the details, then issue it when it is
              ready.
            </p>
          </Empty>
        ) : (
          <div className="record-list">
            {rows.map((row) => (
              <div className="record" key={row.id}>
                <div className="record-main">
                  <strong>{row.payerName}</strong>
                  <small>
                    {row.status === "draft"
                      ? "Draft"
                      : row.issuedAt
                        ? `Issued ${date(row.issuedAt)}`
                        : "Invoice"}{" "}
                    · {row.id.slice(0, 8).toUpperCase()}
                  </small>
                  <small>
                    {row.items?.map((item: Row) => item.description).join(", ")}
                  </small>
                  {row.serviceMonth && (
                    <small>
                      {invoiceCycle(row.serviceMonth).period} classes · Due{" "}
                      {invoiceCycle(row.serviceMonth).due}
                    </small>
                  )}
                </div>
                <strong>{money(row.totalMinor, row.currency)}</strong>
                <span className={`status ${row.status}`}>{row.status}</span>
                <button
                  onClick={() => {
                    setError("");
                    setMessage("");
                    setInvoice(row);
                  }}
                >
                  View invoice
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {creating && (
        <Modal
          title="New invoice"
          onClose={() => {
            if (!busy) setCreating(false);
          }}
        >
          <Notice error={error} />
          <p className="muted">
            Start with a draft. You’ll review it before issuing.
          </p>
          <form onSubmit={create}>
            <div className="form-grid">
              <label>
                Bill to
                <input
                  name="payerName"
                  required
                  maxLength={200}
                  disabled={busy}
                  placeholder="Student, family, or payer name"
                />
              </label>
              <label>
                Currency
                <select
                  name="currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={busy}
                >
                  <option>USD</option>
                  <option>EUR</option>
                  <option>GBP</option>
                  <option>MAD</option>
                </select>
              </label>
              <label>
                Description
                <input
                  name="description"
                  required
                  maxLength={500}
                  disabled={busy}
                  placeholder="For example: Two algebra tutoring sessions"
                />
              </label>
              <label>
                Amount ({currency})
                <input
                  name="price"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  disabled={busy}
                  placeholder="0.00"
                />
              </label>
            </div>
            <div className="invoice-preview-total" aria-live="polite">
              <span>Draft total</span>
              <strong>
                {money(
                  Number.isFinite(Number(price))
                    ? Math.round(Number(price) * 100)
                    : 0,
                  currency,
                )}
              </strong>
            </div>
            <p className="small-note">
              Seller details come from Business profile. Issued invoices keep
              the identity saved at the time of issue.
            </p>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Creating…" : "Create draft"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {invoice && (
        <Modal
          title={
            invoice.status === "draft" ? "Review draft invoice" : "Invoice"
          }
          onClose={() => {
            if (!busy) setInvoice(null);
          }}
        >
          <Notice error={error} message={message} />
          {invoice.status === "draft" && (
            <p className="invoice-draft-note">
              Review the payer, amount, and seller details below. Issue invoice
              saves your business identity on this invoice and makes it ready
              for payment.
            </p>
          )}
          <article className="invoice-sheet">
            <div className="invoice-heading">
              <div>
                {seller?.branding?.logoDataUrl && (
                  <img src={seller.branding.logoDataUrl} alt="Business logo" />
                )}
                <h2>
                  {seller?.profile?.legalName ||
                    seller?.branding?.displayName ||
                    seller?.name ||
                    "Seller details unavailable"}
                </h2>
                {seller?.profile?.address && (
                  <address>
                    {Object.values(seller.profile.address)
                      .filter(Boolean)
                      .join(", ")}
                  </address>
                )}
                <p>
                  {[seller?.profile?.email, seller?.profile?.phone]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {seller?.profile?.taxId && (
                  <small>Tax / registration: {seller.profile.taxId}</small>
                )}
              </div>
              <div>
                <h2>INVOICE</h2>
                <span className={`status ${invoice.status}`}>
                  {invoice.status}
                </span>
                <small>{invoice.id.slice(0, 8).toUpperCase()}</small>
                {invoice.serviceMonth && (
                  <>
                    <small className="invoice-date">
                      Service period:{" "}
                      {invoiceCycle(invoice.serviceMonth).period}
                    </small>
                    <small className="invoice-date">
                      Due: {invoiceCycle(invoice.serviceMonth).due}
                    </small>
                  </>
                )}
                {(invoice.issuedAt || invoice.createdAt) && (
                  <small className="invoice-date">
                    {invoice.issuedAt ? "Issued" : "Created"}{" "}
                    {date(invoice.issuedAt || invoice.createdAt)}
                  </small>
                )}
              </div>
            </div>
            <div className="invoice-recipient">
              <span className="eyebrow">BILL TO</span>
              <h3>{invoice.payerName}</h3>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Quantity</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((item: Row, i: number) => (
                  <tr key={i}>
                    <td>{item.description}</td>
                    <td>{item.quantity}</td>
                    <td>
                      {money(
                        item.quantity * item.unitPriceMinor,
                        invoice.currency,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="invoice-total">
              <span>Total</span>
              <strong>{money(invoice.totalMinor, invoice.currency)}</strong>
            </div>
            <div className="invoice-total">
              <span>Paid</span>
              <span>{money(invoice.paidMinor, invoice.currency)}</span>
            </div>
            <div className="invoice-total">
              <span>Balance due</span>
              <strong>
                {money(
                  invoice.totalMinor - invoice.paidMinor,
                  invoice.currency,
                )}
              </strong>
            </div>
          </article>
          <div className="form-actions">
            <button onClick={() => window.print()}>
              <Printer size={16} />
              Print / save PDF
            </button>
            {invoice.status === "draft" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void issue(invoice.id)}
              >
                {busy ? "Issuing…" : "Issue invoice"}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
export function Payments({
  api,
  role,
  businessId,
}: {
  api: Api;
  role?: string;
  businessId?: string;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [connections, setConnections] = useState<Row[]>([]),
    [invoices, setInvoices] = useState<Row[]>([]),
    [providers, setProviders] = useState<Row[]>([]);
  const [creating, setCreating] = useState(false),
    [connecting, setConnecting] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const keys = useRef(new Map<string, string>());
  const canManage = role === "owner" || role === "admin";
  const stripeAvailable = providers.some(
    (provider) => provider.provider === "stripe" && provider.available,
  );
  const sandboxAvailable = providers.some(
    (provider) => provider.provider === "sandbox" && provider.available,
  );
  const enabledConnections = connections.filter(
    (connection) => connection.status === "enabled",
  );
  const eligibleInvoices = invoices.filter(
    (invoice) =>
      invoice.status === "issued" &&
      Number(invoice.paidMinor ?? 0) === 0 &&
      !rows.some((row) => row.invoiceId === invoice.id),
  );
  function safeCheckoutUrl(value: unknown) {
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" &&
        url.hostname === "checkout.stripe.com" &&
        !url.username &&
        !url.password &&
        !url.port
        ? url.href
        : null;
    } catch {
      return null;
    }
  }
  function checkoutKey(invoiceId: string, connectionId: string) {
    const key = `${businessId ?? "default"}:${invoiceId}:${connectionId}`;
    if (!keys.current.has(key)) keys.current.set(key, crypto.randomUUID());
    return keys.current.get(key)!;
  }
  async function load(active = () => true) {
    const results = await Promise.allSettled([
      api("payments/v1/checkouts"),
      api("payments/v1/connections"),
      api("billing/v1/invoices"),
      api("payments/v1/providers"),
    ]);
    if (!active()) return;
    const setters = [setRows, setConnections, setInvoices, setProviders];
    results.forEach((result, index) => {
      if (result.status === "fulfilled")
        setters[index](result.value.items ?? []);
    });
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    setError(failures.map((result) => errorMessage(result.reason)).join(". "));
    setLoading(false);
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    setRows([]);
    setConnections([]);
    setInvoices([]);
    setProviders([]);
    void load(() => active);
    return () => {
      active = false;
    };
  }, [api]);
  async function act(
    action: () => Promise<any>,
    success: (result: any) => string,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      setCreating(false);
      setConnecting(false);
      await load();
      setMessage(success(result));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      secretKey = String(form.get("secretKey") ?? "").trim();
    if (!/^(sk_test_|rk_test_).+/.test(secretKey)) {
      setError(
        "Use a Stripe test secret key beginning with sk_test_ or rk_test_.",
      );
      return;
    }
    await act(
      () =>
        api("payments/v1/connections", "POST", {
          provider: "stripe",
          displayName:
            String(form.get("displayName") ?? "").trim() ||
            "Stripe test account",
          credentials: { secretKey },
        }),
      () =>
        "Stripe test account connected. Verify the account when you are ready.",
    );
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      invoiceId = String(form.get("invoiceId")),
      connectionId = String(form.get("connectionId"));
    await act(
      () =>
        api(
          "payments/v1/checkouts",
          "POST",
          { invoiceId, connectionId },
          checkoutKey(invoiceId, connectionId),
        ),
      (result) =>
        result.item?.creationStatus === "unknown"
          ? "Payment link creation is uncertain. Use the existing attempt's retry action to resolve it."
          : result.item?.provider === "sandbox"
            ? "Sandbox payment created. Confirm it only when you want to simulate a payment."
            : result.item?.creationStatus === "failed"
              ? "Payment link creation failed. Review the attempt below."
              : "Stripe test payment link created.",
    );
  }
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Test payment link copied.");
    } catch {
      setError("Could not copy the link. Open the test checkout to access it.");
    }
  }
  return (
    <div className="payments-workspace">
      <div className="section-heading">
        <div>
          <h1>Collect payments from your invoices.</h1>
          <p className="muted">
            Create a test checkout for an issued, unpaid invoice and check its
            payment status.
          </p>
        </div>
        <button
          className="primary"
          disabled={
            loading ||
            busy ||
            !eligibleInvoices.length ||
            !enabledConnections.length
          }
          onClick={() => {
            setError("");
            setMessage("");
            setCreating(true);
          }}
        >
          <Plus size={16} />
          Create payment link
        </button>
      </div>
      <Notice error={!creating && !connecting ? error : ""} message={message} />
      <div className="payment-banner payments-test-banner">
        <Wallet size={25} />
        <div>
          <strong>Test mode</strong>
          <p>
            Stripe test checkouts and sandbox confirmations do not collect real
            money. Payment status refresh is manual; webhooks are unavailable.
          </p>
        </div>
        <span className="tag">No real charges</span>
      </div>
      <section className="panel payments-connections">
        <div className="panel-title">
          <h3>Payment accounts</h3>
          {canManage && (
            <button
              disabled={busy || loading || !stripeAvailable}
              onClick={() => {
                setError("");
                setConnecting(true);
              }}
            >
              Connect Stripe test account
            </button>
          )}
        </div>
        {loading && !connections.length ? (
          <p className="muted">Loading payment accounts…</p>
        ) : connections.length ? (
          connections.map((connection) => (
            <div className="payments-account" key={connection.id}>
              <div>
                <strong>{connection.displayName}</strong>
                <small>
                  {connection.provider === "stripe"
                    ? "Stripe · test mode"
                    : "Local sandbox · simulated"}{" "}
                  ·{" "}
                  {connection.status === "enabled"
                    ? "Connected"
                    : connection.status}
                </small>
                {connection.provider === "stripe" && (
                  <small>
                    {connection.config?.verificationStatus === "verified"
                      ? `Account verified${connection.verifiedAt ? ` ${date(connection.verifiedAt)}` : ""}`
                      : "Account not yet verified"}
                  </small>
                )}
              </div>
              {connection.provider === "stripe" && canManage && (
                <button
                  disabled={busy || connection.status !== "enabled"}
                  onClick={() =>
                    void act(
                      () =>
                        api(
                          `payments/v1/connections/${connection.id}/verify`,
                          "POST",
                          {},
                        ),
                      () => "Stripe test account verified.",
                    )
                  }
                >
                  Verify account
                </button>
              )}
            </div>
          ))
        ) : (
          <Empty>
            <h3>Connect a payment account</h3>
            <p>
              Use an existing Stripe account's test key to create test payment
              links.
            </p>
            {!canManage && <p>An owner or admin can connect the account.</p>}
          </Empty>
        )}
        {!loading && !stripeAvailable && (
          <p className="crm-helper">
            Stripe test checkout is unavailable in this environment.
          </p>
        )}
        {sandboxAvailable && (
          <details className="payments-sandbox">
            <summary>Local sandbox</summary>
            <p className="muted">
              Test the invoice workflow locally with an explicit simulated
              confirmation.
            </p>
            <button
              disabled={
                busy ||
                !canManage ||
                connections.some(
                  (connection) => connection.provider === "sandbox",
                )
              }
              onClick={() =>
                void act(
                  () =>
                    api("payments/v1/connections", "POST", {
                      provider: "sandbox",
                      displayName: "Local sandbox",
                    }),
                  () => "Local sandbox connected.",
                )
              }
            >
              {connections.some(
                (connection) => connection.provider === "sandbox",
              )
                ? "Sandbox connected"
                : "Enable sandbox"}
            </button>
          </details>
        )}
      </section>
      {!loading && !eligibleInvoices.length && (
        <div className="payments-next-step">
          <FileText size={18} />
          <p>
            Issue an unpaid invoice in Invoices to create a payment link.
            Invoices with an existing attempt are listed below.
          </p>
        </div>
      )}
      <section className="panel">
        <div className="panel-title">
          <h3>Payment activity</h3>
          <span className="tag">Test / simulated</span>
        </div>
        {loading && !rows.length ? (
          <Empty>Loading payment activity…</Empty>
        ) : !rows.length ? (
          <Empty>
            No payment attempts yet. Connect a test account and choose an issued
            invoice to begin.
          </Empty>
        ) : (
          rows.map((row) => {
            const invoice = invoices.find(
                (invoice) => invoice.id === row.invoiceId,
              ),
              url = safeCheckoutUrl(row.checkoutUrl),
              stripe = row.provider === "stripe",
              stripeSession = /^cs_test_/.test(
                String(row.providerReference ?? ""),
              ),
              canRetry =
                stripe && !stripeSession && row.creationStatus === "unknown";
            const status =
              row.status === "confirmed"
                ? "Confirmed"
                : ((
                    {
                      unknown: "Needs reconciliation",
                      failed: "Creation failed",
                      expired: "Expired",
                      creating: "Creating link",
                    } as Record<string, string>
                  )[row.creationStatus] ?? "Awaiting payment");
            return (
              <article className="payments-attempt" key={row.id}>
                <div className="payments-attempt-heading">
                  <div>
                    <strong>
                      {invoice?.payerName ??
                        `Invoice ${row.invoiceId.slice(0, 8)}`}
                    </strong>
                    <small>
                      {stripe
                        ? "Stripe test mode"
                        : "Local sandbox · simulated"}{" "}
                      · {date(row.createdAt)}
                    </small>
                  </div>
                  <strong>{money(row.amountMinor, row.currency)}</strong>
                  <span className={`status ${row.status}`}>{status}</span>
                </div>
                {row.lastError && (
                  <p className="payments-attempt-error">{row.lastError}</p>
                )}
                {row.creationStatus === "unknown" && (
                  <p className="crm-helper">
                    The provider outcome is uncertain. Resolve this existing
                    attempt before creating another payment.
                  </p>
                )}
                {row.creationStatus === "expired" && (
                  <p className="crm-helper">
                    This checkout expired. A replacement link is not supported
                    yet.
                  </p>
                )}
                <div className="payments-attempt-actions">
                  {url &&
                    row.creationStatus !== "expired" &&
                    row.status !== "confirmed" && (
                      <>
                        <a
                          className="button"
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink size={14} />
                          Open test checkout
                        </a>
                        <button onClick={() => void copyLink(url)}>
                          <Copy size={14} />
                          Copy link
                        </button>
                      </>
                    )}
                  {stripe && stripeSession && canManage && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api(
                              `payments/v1/checkouts/${row.id}/refresh`,
                              "POST",
                              {},
                            ),
                          (result) =>
                            result.item?.status === "confirmed"
                              ? "Stripe confirmed the test payment. The invoice will update after processing."
                              : "Payment status refreshed.",
                        )
                      }
                    >
                      <RefreshCw size={14} />
                      Refresh status
                    </button>
                  )}
                  {canRetry && canManage && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api(
                              "payments/v1/checkouts",
                              "POST",
                              {
                                invoiceId: row.invoiceId,
                                connectionId: row.connectionId,
                              },
                              checkoutKey(row.invoiceId, row.connectionId),
                            ),
                          (result) =>
                            result.item?.creationStatus === "ready"
                              ? "Existing checkout resolved. Your test payment link is ready."
                              : "Existing checkout retried. Review its current status.",
                        )
                      }
                    >
                      Retry link creation
                    </button>
                  )}
                  {row.status === "pending" && row.provider === "sandbox" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api(
                              `payments/v1/checkouts/${row.id}/sandbox-confirm`,
                              "POST",
                              {},
                            ),
                          () =>
                            "Sandbox payment simulated. No money was collected.",
                        )
                      }
                    >
                      Simulate payment
                    </button>
                  )}
                  {row.lastRefreshedAt && (
                    <small>Last checked {date(row.lastRefreshedAt)}</small>
                  )}
                </div>
              </article>
            );
          })
        )}
      </section>
      {connecting && (
        <Modal
          title="Connect Stripe test account"
          onClose={() => {
            if (!busy) {
              setConnecting(false);
              setError("");
            }
          }}
        >
          <Notice error={error} />
          <p className="muted">
            Use a test secret or restricted key from your existing Stripe
            account. The key is encrypted and cannot be read back here.
          </p>
          <form onSubmit={connect}>
            <label>
              Account label (optional)
              <input
                name="displayName"
                maxLength={200}
                placeholder="Stripe test account"
                disabled={busy}
              />
            </label>
            <label>
              Stripe test secret key
              <input
                type="password"
                name="secretKey"
                required
                pattern="(sk_test_|rk_test_).+"
                autoComplete="off"
                spellCheck={false}
                maxLength={5000}
                placeholder="sk_test_… or rk_test_…"
                disabled={busy}
              />
              <span className="crm-helper">
                Only test keys are accepted. Live keys cannot be connected.
              </span>
            </label>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConnecting(false);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Connecting…" : "Connect test account"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {creating && (
        <Modal
          title="Create payment link"
          onClose={() => {
            if (!busy) {
              setCreating(false);
              setError("");
            }
          }}
        >
          <Notice error={error} />
          <p className="muted">
            The issued invoice determines the amount and currency. This checkout
            runs in test mode.
          </p>
          <form onSubmit={create}>
            <label>
              Issued, unpaid invoice
              <select name="invoiceId" required disabled={busy}>
                <option value="">Choose invoice</option>
                {eligibleInvoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.payerName} ·{" "}
                    {money(invoice.totalMinor, invoice.currency)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Payment account
              <select name="connectionId" required disabled={busy}>
                <option value="">Choose test account</option>
                {enabledConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.displayName} ·{" "}
                    {connection.provider === "stripe"
                      ? "Stripe test"
                      : "Local sandbox"}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Creating…" : "Create test checkout"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
export function Activity({ api }: { api: Api }) {
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api("notifications/v1/notifications")
      .then((data) => {
        if (active) setRows(data.items);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <>
      <h1>Workspace activity</h1>
      <Notice error={error} />
      <section className="panel">
        {rows.length ? (
          rows.map((row) => (
            <div className="record" key={row.id}>
              <div className="record-main">
                <strong>{row.title}</strong>
                <small>{row.message}</small>
              </div>
              <span className="tag">{row.status}</span>
            </div>
          ))
        ) : (
          <Empty>Activity appears here as you use your workspace.</Empty>
        )}
      </section>
    </>
  );
}
