import { useEffect, useState, type FormEvent } from "react";
import {
  Mail,
  MessageCircle,
  Plus,
  Send,
  Sparkles,
  Unplug,
} from "lucide-react";
import { Modal, Notice, Empty } from "../components/shared";
import { date, errorMessage, type Api, type Row } from "../lib/api";
import "./communications.css";
export type Audience = {
  clientIds?: string[];
  filter?: Record<string, unknown>;
};
const providerNames: Record<string, string> = {
  smtp: "Email · SMTP",
  resend: "Email · Resend",
  whatsapp_business: "WhatsApp Business",
  ai_agent: "AI drafting agent",
};
const prefix = "notifications/v1";
export function CommunicationConnections({
  api,
  role,
}: {
  api: Api;
  role: string;
}) {
  const [items, setItems] = useState<Row[]>([]),
    [provider, setProvider] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const manage = ["owner", "admin"].includes(role);
  async function load() {
    try {
      setItems((await api(`${prefix}/communication-connections`)).items);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, [api]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      get = (n: string) => String(f.get(n) || "");
    setBusy(true);
    setError("");
    try {
      const config =
        provider === "smtp"
          ? {
              host: get("host"),
              port: Number(get("port")),
              fromEmail: get("fromEmail"),
              fromName: get("fromName") || undefined,
            }
          : provider === "resend"
            ? {
                fromEmail: get("fromEmail"),
                fromName: get("fromName") || undefined,
              }
            : provider === "whatsapp_business"
              ? {
                  phoneNumberId: get("phoneNumberId"),
                  apiVersion: get("apiVersion"),
                }
              : { endpointUrl: get("endpointUrl") };
      const credentials =
        provider === "smtp"
          ? { username: get("username"), password: get("password") }
          : provider === "resend"
            ? { apiKey: get("apiKey") }
            : provider === "whatsapp_business"
              ? { accessToken: get("accessToken") }
              : {
                  ...(get("bearerToken")
                    ? { bearerToken: get("bearerToken") }
                    : {}),
                };
      await api(`${prefix}/communication-connections`, "POST", {
        provider,
        displayName: get("displayName"),
        config,
        credentials,
      });
      setProvider("");
      setNotice("Connection saved. Sending requires an approved campaign.");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel comm-connections">
      <div className="panel-title">
        <div>
          <h2>Your messaging tools</h2>
          <p className="muted">
            Use your business’s sender, WhatsApp number, and AI drafting agent.
          </p>
        </div>
      </div>
      <Notice error={!provider ? error : ""} message={notice} />
      <div className="comm-provider-grid">
        {Object.entries(providerNames).map(([id, label]) => (
          <button
            key={id}
            disabled={!manage || busy}
            onClick={() => {
              setError("");
              setProvider(id);
            }}
          >
            <span>
              {id === "ai_agent" ? (
                <Sparkles size={20} />
              ) : id === "whatsapp_business" ? (
                <MessageCircle size={20} />
              ) : (
                <Mail size={20} />
              )}
            </span>
            <strong>{label}</strong>
            <small>Connect your own account</small>
            <Plus size={16} />
          </button>
        ))}
      </div>
      {!manage && (
        <p className="muted">
          Your business owner or admin can connect these tools.
        </p>
      )}
      {items.map((c) => (
        <div className="record" key={c.id}>
          <div className="record-main">
            <strong>{c.displayName}</strong>
            <small>
              {providerNames[c.provider]} ·{" "}
              {c.config.fromEmail ||
                c.config.phoneNumberId ||
                c.config.host ||
                c.config.endpointUrl}
            </small>
          </div>
          <span className="status">
            {c.status === "active" ? "Configured" : "Disabled"}
          </span>
          {manage && c.status === "active" && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(
                    `${prefix}/communication-connections/${c.id}`,
                    "DELETE",
                  );
                  await load();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Unplug size={14} />
              Disable
            </button>
          )}
        </div>
      ))}
      {provider && (
        <Modal
          title={`Connect ${providerNames[provider]}`}
          onClose={() => !busy && setProvider("")}
        >
          <form className="comm-form" onSubmit={create}>
            <Notice error={error} />
            <label>
              Connection name
              <input
                name="displayName"
                required
                maxLength={100}
                placeholder="For example: Student updates"
              />
            </label>
            {["smtp", "resend"].includes(provider) && (
              <div className="form-grid">
                <label>
                  Sender email
                  <input
                    name="fromEmail"
                    type="email"
                    required
                    placeholder="hello@yourbusiness.com"
                  />
                </label>
                <label>
                  Sender name (optional)
                  <input name="fromName" maxLength={100} />
                </label>
              </div>
            )}
            {provider === "smtp" && (
              <>
                <div className="form-grid">
                  <label>
                    SMTP server
                    <input
                      name="host"
                      required
                      placeholder="smtp.yourprovider.com"
                    />
                  </label>
                  <label>
                    TLS port
                    <select name="port" defaultValue="587">
                      <option value="587">587 · STARTTLS</option>
                      <option value="465">465 · TLS</option>
                    </select>
                  </label>
                </div>
                <label>
                  Username
                  <input name="username" required autoComplete="off" />
                </label>
                <label>
                  App password
                  <input
                    name="password"
                    type="password"
                    required
                    autoComplete="new-password"
                  />
                </label>
                <small className="muted">
                  Use the app password provided by your email service.
                </small>
              </>
            )}
            {provider === "resend" && (
              <>
                <label>
                  Resend API key
                  <input
                    type="password"
                    name="apiKey"
                    required
                    autoComplete="new-password"
                  />
                </label>
                <small className="muted">
                  Your sender domain must be verified in Resend.
                </small>
              </>
            )}
            {provider === "whatsapp_business" && (
              <>
                <label>
                  Phone number ID
                  <input name="phoneNumberId" required inputMode="numeric" />
                </label>
                <label>
                  Graph API version
                  <input
                    name="apiVersion"
                    required
                    pattern="v[0-9]+\.[0-9]+"
                    placeholder="Version used by your Meta app, e.g. v25.0"
                  />
                </label>
                <label>
                  Meta access token
                  <input
                    name="accessToken"
                    type="password"
                    required
                    autoComplete="new-password"
                  />
                </label>
                <small className="muted">
                  Use your WhatsApp Business Platform account. Campaigns use
                  templates approved by Meta.
                </small>
              </>
            )}
            {provider === "ai_agent" && (
              <>
                <label>
                  Agent HTTPS endpoint
                  <input
                    name="endpointUrl"
                    type="url"
                    required
                    placeholder="https://your-agent.com/draft"
                  />
                </label>
                <label>
                  Bearer token (optional)
                  <input
                    name="bearerToken"
                    type="password"
                    autoComplete="new-password"
                  />
                </label>
                <small className="muted">
                  Your agent receives writing instructions and draft text, and
                  returns subject and message. Review the result before sending.
                </small>
              </>
            )}
            <p className="muted">
              Credentials are encrypted and aren’t displayed again. Saving does
              not send a message or verify delivery.
            </p>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setProvider("")}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save connection"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
export function CampaignComposer({
  api,
  role,
  audience,
  onClose,
}: {
  api: Api;
  role: string;
  audience: Audience;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<Row[]>([]),
    [channel, setChannel] = useState("email"),
    [connectionId, setConnectionId] = useState(""),
    [subject, setSubject] = useState(""),
    [message, setMessage] = useState(""),
    [templateName, setTemplateName] = useState(""),
    [language, setLanguage] = useState("en_US"),
    [parameters, setParameters] = useState(""),
    [agentId, setAgentId] = useState(""),
    [instruction, setInstruction] = useState(""),
    [draft, setDraft] = useState<Row | null>(null),
    [history, setHistory] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [delivery, setDelivery] = useState(false),
    [loaded, setLoaded] = useState(false);
  const manage = ["owner", "admin"].includes(role);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api(`${prefix}/communication-connections`),
      api(`${prefix}/campaigns`),
    ])
      .then(([c, h]) => {
        if (alive) {
          setConnections(c.items);
          setDelivery(c.deliveryEnabled);
          setHistory(h.items);
          setLoaded(true);
        }
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [api]);
  const available = connections.filter(
    (c) =>
      c.status === "active" &&
      (channel === "email"
        ? ["smtp", "resend"].includes(c.provider)
        : c.provider === "whatsapp_business"),
  );
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function review(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      const result = await api(`${prefix}/campaigns`, "POST", {
        connectionId,
        channel,
        selection: audience,
        ...(channel === "email"
          ? { subject, message }
          : {
              template: {
                name: templateName,
                language,
                parameters: parameters ? parameters.split("\n") : [],
              },
            }),
      });
      setDraft({ ...result.item, recipients: result.recipients });
      setDelivery(result.deliveryEnabled);
      setHistory((await api(`${prefix}/campaigns`)).items);
    });
  }
  return (
    <Modal
      title={draft ? "Review message campaign" : "Message CRM contacts"}
      onClose={() => !busy && onClose()}
    >
      <Notice error={error} />
      {!delivery && loaded && (
        <div className="comm-info">
          Sending is disabled in this local workspace. You can configure
          connections and review drafts.
        </div>
      )}
      {draft ? (
        <>
          <div className="comm-preview-stats">
            <div>
              <strong>{draft.totalRecipients}</strong>
              <small>Selected contacts</small>
            </div>
            <div>
              <strong>{draft.eligibleRecipients}</strong>
              <small>Ready to send</small>
            </div>
            <div>
              <strong>{draft.counts.skipped}</strong>
              <small>Skipped</small>
            </div>
          </div>
          <p className="muted">
            Recipients without permission or a valid address are skipped. This
            draft keeps the reviewed audience and content.
          </p>
          <section className="comm-recipient-list">
            {draft.recipients?.map((r: Row) => (
              <details key={r.id}>
                <summary>
                  <strong>{r.displayName}</strong>
                  <span>{r.status === "pending" ? "Ready" : r.status}</span>
                </summary>
                <small>
                  {r.address || "No contact address"}
                  {r.reason && ` · ${r.reason.replaceAll("_", " ")}`}
                </small>
                {r.subject && <h4>{r.subject}</h4>}
                <p className="comm-message-text">
                  {r.message || JSON.stringify(r.template)}
                </p>
              </details>
            ))}
          </section>
          <div className="form-actions">
            <button disabled={busy} onClick={() => setDraft(null)}>
              Create another draft
            </button>
            {draft.status === "draft" && (
              <button
                className="primary"
                disabled={
                  busy || !manage || !delivery || draft.eligibleRecipients === 0
                }
                onClick={() =>
                  void act(async () => {
                    const r = await api(
                      `${prefix}/campaigns/${draft.id}/send`,
                      "POST",
                      { confirmationToken: draft.confirmationToken },
                    );
                    const d = await api(`${prefix}/campaigns/${r.item.id}`);
                    setDraft({ ...d.item, recipients: d.recipients });
                  })
                }
              >
                <Send size={16} />
                {busy
                  ? "Queuing…"
                  : `Approve & send to ${draft.eligibleRecipients}`}
              </button>
            )}
            {draft.status === "queued" && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await api(`${prefix}/campaigns/${draft.id}`);
                    setDraft({ ...r.item, recipients: r.recipients });
                  })
                }
              >
                Refresh status
              </button>
            )}
          </div>
          <small className="muted">
            Accepted means the provider accepted the message; it does not
            confirm delivery.
          </small>
        </>
      ) : (
        <form className="comm-form" onSubmit={review}>
          <p className="muted">
            {audience.clientIds
              ? `${audience.clientIds.length} selected contacts`
              : "All contacts matching your current filters"}
            . You’ll review recipients and personalized messages before sending.
          </p>
          <div className="form-grid">
            <label>
              Channel
              <select
                value={channel}
                onChange={(e) => {
                  setChannel(e.target.value);
                  setConnectionId("");
                }}
              >
                <option value="email">Email</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
            </label>
            <label>
              Send from
              <select
                value={connectionId}
                required
                onChange={(e) => setConnectionId(e.target.value)}
              >
                <option value="">Choose a connection</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {loaded && !available.length && (
            <p className="comm-info">
              Connect your{" "}
              {channel === "email"
                ? "sender email"
                : "WhatsApp Business account"}{" "}
              in Connectors first.
            </p>
          )}
          {channel === "email" ? (
            <>
              <label>
                Subject
                <input
                  required
                  maxLength={200}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </label>
              <label>
                Message
                <textarea
                  rows={6}
                  required
                  maxLength={10000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Hi {{firstName}}, …"
                />
              </label>
              <small className="muted">
                Personalize with{" "}
                {
                  "{{firstName}}, {{lastName}}, {{displayName}}, or {{custom:column-id}}"
                }
                .
              </small>
              {connections.some(
                (c) => c.provider === "ai_agent" && c.status === "active",
              ) && (
                <details className="comm-ai">
                  <summary>
                    <Sparkles size={15} />
                    Help me write this
                  </summary>
                  <label>
                    Drafting agent
                    <select
                      value={agentId}
                      onChange={(e) => setAgentId(e.target.value)}
                    >
                      <option value="">Choose an agent</option>
                      {connections
                        .filter(
                          (c) =>
                            c.provider === "ai_agent" && c.status === "active",
                        )
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Writing instructions
                    <textarea
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      maxLength={4000}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !agentId || !instruction}
                    onClick={() =>
                      void act(async () => {
                        const r = await api(
                          `${prefix}/communication-connections/${agentId}/generate`,
                          "POST",
                          { instruction, subject, message },
                        );
                        setSubject(r.item.subject);
                        setMessage(r.item.message);
                      })
                    }
                  >
                    Generate draft
                  </button>
                  <small className="muted">
                    Only instructions and draft text go to your agent. It cannot
                    send this campaign.
                  </small>
                </details>
              )}
            </>
          ) : (
            <>
              <label>
                Approved Meta template name
                <input
                  required
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="lesson_reminder"
                />
              </label>
              <label>
                Template language
                <input
                  required
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="en_US"
                />
              </label>
              <label>
                Body parameters · one per line
                <textarea
                  rows={4}
                  value={parameters}
                  onChange={(e) => setParameters(e.target.value)}
                  placeholder={"{{firstName}}\nYour next lesson"}
                />
              </label>
              <small className="muted">
                Use the template name and language configured in WhatsApp
                Manager. Body parameters follow the template’s numbered order.
              </small>
            </>
          )}
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || !loaded || !manage || !available.length}
            >
              {busy ? "Preparing preview…" : "Review recipients & save draft"}
            </button>
          </div>
        </form>
      )}
      {history.length > 0 && (
        <details className="comm-history">
          <summary>Recent campaigns</summary>
          {history.map((c) => (
            <button
              type="button"
              key={c.id}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api(`${prefix}/campaigns/${c.id}`);
                  setDraft({ ...r.item, recipients: r.recipients });
                })
              }
            >
              <span>
                {c.subject || c.template?.name || c.channel}
                <small>{date(c.createdAt)}</small>
              </span>
              <span>
                {c.status} · {c.totalRecipients} contacts
              </span>
            </button>
          ))}
        </details>
      )}
    </Modal>
  );
}
