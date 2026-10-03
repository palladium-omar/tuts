import { useEffect, useState, type FormEvent } from "react";
import { Plus, Printer, Wallet } from "lucide-react";
import {
  errorMessage,
  money,
  type Api,
  type Business,
  type Row,
} from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
export function Invoices({ api, business }: { api: Api; business: Business }) {
  const [rows, setRows] = useState<Row[]>([]),
    [creating, setCreating] = useState(false),
    [invoice, setInvoice] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    try {
      setRows((await api("billing/v1/invoices")).items);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, [api]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const [whole, fraction = ""] = String(f.get("price")).split(".");
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
            unitPriceMinor:
              Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
          },
        ],
      });
      setCreating(false);
      setInvoice(result.item);
      await load();
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
            setCreating(true);
          }}
        >
          <Plus size={16} />
          New invoice
        </button>
      </div>
      <Notice error={!creating && !invoice ? error : ""} />
      <section className="panel">
        {!rows.length ? (
          <Empty>Create your first invoice to get started.</Empty>
        ) : (
          <div className="record-list">
            {rows.map((row) => (
              <div className="record" key={row.id}>
                <div className="record-main">
                  <strong>{row.payerName}</strong>
                  <small>
                    {row.items?.map((item: Row) => item.description).join(", ")}
                  </small>
                </div>
                <strong>{money(row.totalMinor, row.currency)}</strong>
                <span className={`status ${row.status}`}>{row.status}</span>
                <button
                  onClick={() => {
                    setError("");
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
          <form onSubmit={create}>
            <div className="form-grid">
              <label>
                Bill to
                <input name="payerName" required maxLength={200} />
              </label>
              <label>
                Currency
                <select name="currency">
                  <option>USD</option>
                  <option>EUR</option>
                  <option>GBP</option>
                  <option>MAD</option>
                </select>
              </label>
              <label>
                Description
                <input name="description" required maxLength={500} />
              </label>
              <label>
                Amount
                <input
                  name="price"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </label>
            </div>
            <p className="small-note">
              Seller details come from Business profile. Issued invoices keep
              the identity saved at the time of issue.
            </p>
            <div className="form-actions">
              <button className="primary" disabled={busy}>
                {busy ? "Creating…" : "Create draft"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {invoice && (
        <Modal
          title="Invoice"
          onClose={() => {
            if (!busy) setInvoice(null);
          }}
        >
          <Notice error={error} />
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
