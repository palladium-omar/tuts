import { useEffect, useState, type FormEvent } from "react";
import { FileText, Plus, Printer, Wallet } from "lucide-react";
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
        {loading ? (
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
export function Payments({ api }: { api: Api }) {
  const [rows, setRows] = useState<Row[]>([]),
    [connections, setConnections] = useState<Row[]>([]),
    [invoices, setInvoices] = useState<Row[]>([]),
    [creating, setCreating] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const results = await Promise.all([
        api("payments/v1/checkouts"),
        api("payments/v1/connections"),
        api("billing/v1/invoices"),
      ]);
      setRows(results[0].items);
      setConnections(results[1].items);
      setInvoices(results[2].items);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, [api]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setCreating(false);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Payments to your business.</h1>
          <p className="muted">
            Manage the payment methods your clients can use.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={16} />
          New payment
        </button>
      </div>
      <Notice error={error} />
      <div className="payment-banner">
        <Wallet size={25} />
        <div>
          <strong>Local payment sandbox</strong>
          <p>
            Live Stripe, PayPal, and bank payments are not available yet.
            Sandbox confirmations do not move money.
          </p>
        </div>
        <button
          disabled={busy || connections.some((c) => c.provider === "sandbox")}
          onClick={() =>
            void act(() =>
              api("payments/v1/connections", "POST", {
                provider: "sandbox",
                displayName: "Local sandbox",
              }),
            )
          }
        >
          {connections.some((c) => c.provider === "sandbox")
            ? "Sandbox connected"
            : "Enable sandbox"}
        </button>
      </div>
      <section className="panel">
        {!rows.length ? (
          <Empty>No payment activity yet.</Empty>
        ) : (
          rows.map((row) => (
            <div className="record" key={row.id}>
              <div className="record-main">
                <strong>Payment {row.id.slice(0, 8)}</strong>
                <small>Sandbox · simulated</small>
              </div>
              <strong>{money(row.amountMinor, row.currency)}</strong>
              <span className={`status ${row.status}`}>{row.status}</span>
              {row.status === "pending" && row.simulated && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api(
                        `payments/v1/checkouts/${row.id}/sandbox-confirm`,
                        "POST",
                        {},
                      ),
                    )
                  }
                >
                  Simulate payment
                </button>
              )}
            </div>
          ))
        )}
      </section>
      {creating && (
        <Modal title="Sandbox payment" onClose={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(() =>
                api("payments/v1/checkouts", "POST", {
                  invoiceId: f.get("invoiceId"),
                  connectionId: f.get("connectionId"),
                }),
              );
            }}
          >
            <label>
              Invoice
              <select name="invoiceId" required>
                <option value="">Choose issued invoice</option>
                {invoices
                  .filter((i) => i.status === "issued")
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.payerName} · {money(i.totalMinor, i.currency)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Connection
              <select name="connectionId" required>
                <option value="">Choose sandbox</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button className="primary" disabled={busy}>
                Create sandbox payment
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
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
