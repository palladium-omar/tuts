import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Plug,
  Plus,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { date, errorMessage, gateway, type Api, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import "./setup-ux.css";
const names: Record<string, string> = {
  calendly: "Calendly",
  calcom: "Cal.com",
  json_api: "Contact API",
  form_webhook: "Website form",
};
const descriptions: Record<string, string> = {
  calendly: "Bring bookings, attendees, and cancellations into Tuts.",
  calcom: "Keep your Cal.com bookings and client records in sync.",
  json_api:
    "Pull contacts from an existing database or app through its HTTPS JSON API.",
  form_webhook:
    "Send new inquiries from your website, form tool, or automation into your CRM.",
};
const fields: Record<string, string> = {
  externalId: "Record ID",
  displayName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  notes: "Notes",
  tags: "Tags",
};
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.href;
  } catch {}
  return;
}
export function Connectors({
  api,
  role,
  filter = "all",
}: {
  api: Api;
  role: string;
  filter?: "all" | "calendars" | "crm";
}) {
  const [connections, setConnections] = useState<Row[]>([]),
    [provider, setProvider] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(""),
    [secret, setSecret] = useState<Row | null>(null),
    [loading, setLoading] = useState(true);
  const [mapping, setMapping] = useState<Record<string, string>>({
    externalId: "id",
    displayName: "name",
    email: "email",
  });
  const canManage = ["owner", "admin"].includes(role);
  const providers = Object.keys(names).filter(
    (p) =>
      filter === "all" ||
      (filter === "calendars"
        ? ["calendly", "calcom"].includes(p)
        : ["json_api", "form_webhook"].includes(p)),
  );
  async function load() {
    setLoading(true);
    try {
      const data = await api("integrations/v1/connections");
      setConnections(data.items);
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
  async function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy("connect");
    setError("");
    try {
      const config: Row = {};
      if (f.get("bookingUrl")) config.bookingUrl = f.get("bookingUrl");
      if (f.get("url")) config.url = f.get("url");
      if (f.get("recordsPath")) config.recordsPath = f.get("recordsPath");
      if (["json_api", "form_webhook"].includes(provider))
        config.mapping = Object.fromEntries(
          Object.entries(mapping).filter(([, v]) => v),
        );
      const data = await api("integrations/v1/connections", "POST", {
        provider,
        displayName: f.get("displayName") || names[provider],
        credentials: f.get("token") ? { token: f.get("token") } : {},
        config,
      });
      const item = data.item ?? data;
      const webhookSecret = data.webhookSecret ?? item.webhookSecret;
      const webhookPath = data.webhookPath ?? item.webhookPath;
      if (webhookSecret) setSecret({ webhookSecret, webhookPath });
      setProvider("");
      setMessage(
        provider === "form_webhook"
          ? "Form source created. Copy its secret below."
          : "Connected. Use Sync now to pull the latest records.",
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function sync(id: string) {
    setBusy(id);
    setError("");
    try {
      const data = await api(
        `integrations/v1/connections/${id}/sync`,
        "POST",
        {},
      );
      const item = data.item ?? data;
      setMessage(
        `Received ${item.contactsReceived ?? 0} contacts and ${item.sessionsSynced ?? 0} sessions.${item.truncated ? " More records remain; see connector status." : ""} CRM updates are processed in the background.`,
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function disconnect(id: string) {
    setBusy(id);
    setError("");
    try {
      await api(`integrations/v1/connections/${id}`, "DELETE");
      await load();
      setMessage("Source disconnected. Imported CRM contacts are kept.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  const visible = connections.filter(
    (c) => providers.includes(c.provider) && c.status !== "disconnected",
  );
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>
            {filter === "calendars"
              ? "Connect your booking tools."
              : "Your tools, connected."}
          </h1>
          <p className="muted">
            Keep using the tools that work for you. Tuts brings their
            information into your workspace.
          </p>
        </div>
        <button
          aria-label="Refresh connectors"
          disabled={loading || !!busy}
          onClick={() => void load()}
        >
          <RefreshCw size={17} />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <Notice error={provider ? "" : error} message={message} />
      {secret && (
        <section className="panel secret-panel">
          <div className="panel-title">
            <h3>Your form connection</h3>
            <button onClick={() => setSecret(null)}>Dismiss</button>
          </div>
          <p>
            Use this URL and secret in your form service or website backend. The
            secret is only shown once. Keep it out of public website code.
          </p>
          {/localhost|127\.0\.0\.1/.test(new URL(gateway).hostname) && (
            <p className="small-note">
              This is a local workspace. External form tools need a publicly
              reachable HTTPS Tuts address; this URL only works on your machine.
            </p>
          )}
          <label>
            Webhook URL
            <input
              readOnly
              value={`${gateway}${String(secret.webhookPath).startsWith("/api/") ? secret.webhookPath : `/api/integrations${secret.webhookPath}`}`}
            />
          </label>
          <label>
            Authorization header
            <input readOnly value={`Bearer ${secret.webhookSecret}`} />
          </label>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(`Bearer ${secret.webhookSecret}`)
                .then(() => setMessage("Authorization header copied."))
                .catch(() =>
                  setError(
                    "Copy the authorization header from the field above.",
                  ),
                )
            }
          >
            <Copy size={15} />
            Copy secret header
          </button>
          <p className="small-note">
            Send a JSON object or array containing the mapped contact fields.
            Use your form tool’s webhook action, Zapier/Make, or your own
            backend.
          </p>
        </section>
      )}
      <div className="connector-grid">
        {providers.map((p) => (
          <section className="panel connector-card" key={p}>
            <div className={`connector-icon ${p}`}>
              {p === "calendly" ? (
                "C"
              ) : p === "calcom" ? (
                "Cal"
              ) : (
                <Plug size={25} />
              )}
            </div>
            <h3>{names[p]}</h3>
            <p className="muted">{descriptions[p]}</p>
            <span className="setup-connector-requirement">
              {p === "calendly"
                ? "Personal access token required"
                : p === "calcom"
                  ? "API key required"
                  : p === "json_api"
                    ? "HTTPS contact endpoint required"
                    : "Server-side webhook setup"}
            </span>
            <button
              className="primary"
              disabled={!canManage}
              onClick={() => {
                setProvider(p);
                setError("");
                setMapping({
                  externalId: "id",
                  displayName: "name",
                  email: "email",
                });
              }}
            >
              <Plus size={16} />
              Connect {names[p]}
            </button>
          </section>
        ))}
      </div>
      <section className="panel">
        <div className="panel-title">
          <h3>Connected sources</h3>
          <span className="tag">{visible.length}</span>
        </div>
        {loading ? (
          <Empty>Loading connections…</Empty>
        ) : !visible.length ? (
          <Empty>
            Your connections will appear here. Calendar and API sources sync
            every five minutes.
          </Empty>
        ) : (
          <div className="record-list">
            {visible.map((c) => (
              <div className="connection-record" key={c.id}>
                <div className="record-main">
                  <strong>{c.displayName}</strong>
                  <small>
                    {names[c.provider]} ·{" "}
                    {c.lastSyncAt
                      ? `Last sync ${date(c.lastSyncAt)}`
                      : "Not synced yet"}
                  </small>
                  {c.lastError && (
                    <p className="inline-error">
                      {typeof c.lastError === "string"
                        ? c.lastError
                        : JSON.stringify(c.lastError)}
                    </p>
                  )}
                  {c.lastImportResult && (
                    <small>
                      CRM latest batch: {c.lastImportResult.created ?? 0} added
                      · {c.lastImportResult.updated ?? 0} updated ·{" "}
                      {c.lastImportResult.skipped ?? 0} skipped
                      {c.lastImportResult.errors
                        ? ` · ${c.lastImportResult.errors} errors`
                        : ""}
                    </small>
                  )}
                </div>
                <span className={`status ${c.status}`}>{c.status}</span>
                <div className="record-actions">
                  {safeLink(c.config?.bookingUrl ?? c.account?.bookingUrl) && (
                    <a
                      className="button"
                      href={safeLink(
                        c.config?.bookingUrl ?? c.account?.bookingUrl,
                      )}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open booking page
                      <ArrowUpRight size={14} />
                    </a>
                  )}
                  {c.provider !== "form_webhook" && (
                    <button
                      disabled={!!busy || !canManage}
                      onClick={() => void sync(c.id)}
                    >
                      <RefreshCw size={15} />
                      {busy === c.id ? "Syncing…" : "Sync now"}
                    </button>
                  )}
                  {canManage && (
                    <button
                      className="icon-button"
                      disabled={!!busy}
                      title="Disconnect source"
                      aria-label={`Disconnect ${c.displayName}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Disconnect ${c.displayName}? Imported CRM contacts will remain.`,
                          )
                        )
                          void disconnect(c.id);
                      }}
                    >
                      <Unplug size={16} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {provider && (
        <Modal
          title={`Connect ${names[provider]}`}
          onClose={() => {
            if (!busy) setProvider("");
          }}
        >
          <p className="muted">{descriptions[provider]}</p>
          <Notice error={error} />
          <form onSubmit={connect}>
            <label>
              Connection name
              <input
                name="displayName"
                defaultValue={names[provider]}
                required
                maxLength={100}
              />
            </label>
            {["calendly", "calcom"].includes(provider) && (
              <div className="setup-connector-guide">
                <strong>Connect in two steps</strong>
                <ol>
                  <li>
                    Open{" "}
                    {provider === "calendly" ? (
                      <a
                        href="https://calendly.com/integrations/api_webhooks"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Calendly API & webhooks <ArrowUpRight size={12} />
                      </a>
                    ) : (
                      <a
                        href="https://app.cal.com/settings/developer/api-keys"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Cal.com API keys <ArrowUpRight size={12} />
                      </a>
                    )}{" "}
                    and create{" "}
                    {provider === "calendly"
                      ? "a personal access token with access to your profile, scheduled events, and invitees"
                      : "an API key"}
                    .
                  </li>
                  <li>
                    Paste it below. Tuts validates it before saving the
                    connection.
                  </li>
                </ol>
                <p>
                  Credentials are stored encrypted. Recent and upcoming bookings
                  sync every five minutes; imports start 90 days ago. You can
                  also choose Sync now. Manage availability and rescheduling in{" "}
                  {names[provider]}.
                </p>
              </div>
            )}
            {provider !== "form_webhook" && (
              <label>
                {provider === "json_api"
                  ? "Bearer token (optional)"
                  : provider === "calcom"
                    ? "API key"
                    : "Personal access token"}
                <input
                  name="token"
                  type="password"
                  required={provider !== "json_api"}
                  autoComplete="off"
                  placeholder={
                    provider === "calcom"
                      ? "Paste your Cal.com API key"
                      : provider === "calendly"
                        ? "Paste your Calendly personal access token"
                        : "Bearer token, if your endpoint requires one"
                  }
                />
              </label>
            )}
            {["calendly", "calcom"].includes(provider) && (
              <label>
                Your public booking page (optional)
                <input
                  name="bookingUrl"
                  type="url"
                  placeholder={
                    provider === "calendly"
                      ? "https://calendly.com/your-name"
                      : "https://cal.com/your-name"
                  }
                />
                <small className="small-note">
                  Adds a shortcut to your booking page. The token above is
                  required to import bookings.
                </small>
              </label>
            )}
            {provider === "json_api" && (
              <>
                <label>
                  Contacts API URL
                  <input
                    name="url"
                    type="url"
                    required
                    placeholder="https://your-website.com/api/contacts"
                  />
                </label>
                <label>
                  Path to the records (optional)
                  <input name="recordsPath" placeholder="data.contacts" />
                </label>
                <p className="small-note">
                  An HTTPS endpoint returning a JSON array, or an object
                  containing one. Requests are read-only. Supports up to 2,000
                  records per sync; use a dedicated export endpoint for larger
                  databases.
                </p>
              </>
            )}
            {["json_api", "form_webhook"].includes(provider) && (
              <>
                <h3 className="form-section-title">Match your source fields</h3>
                <p className="muted">
                  Enter the field names your source uses. A stable record ID or
                  email avoids duplicate contacts.
                </p>
                <div className="form-grid">
                  {Object.entries(fields).map(([field, label]) => (
                    <label key={field}>
                      {label}
                      <input
                        value={mapping[field] ?? ""}
                        onChange={(e) =>
                          setMapping({ ...mapping, [field]: e.target.value })
                        }
                        placeholder={field}
                      />
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="form-actions">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setProvider("")}
              >
                Cancel
              </button>
              <button className="primary" disabled={!!busy}>
                {busy
                  ? "Connecting…"
                  : provider === "form_webhook"
                    ? "Create form source"
                    : "Connect securely"}
                <Check size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
