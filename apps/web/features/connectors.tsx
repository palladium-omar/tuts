import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Plug,
  Plus,
  RefreshCw,
  Unplug,
  CalendarDays,
} from "lucide-react";
import { date, errorMessage, gateway, type Api, type Row } from "../lib/api";
import { Empty, Modal, Notice } from "../components/shared";
import { BrandLogo } from "../components/brand-logo";
import "./setup-ux.css";
const names: Record<string, string> = {
  calendly: "Calendly",
  calcom: "Cal.com",
  google_calendar: "Google Calendar",
  json_api: "Contact API",
  form_webhook: "Website form",
};
const descriptions: Record<string, string> = {
  calendly: "Bring bookings, attendees, and cancellations into Tuts.",
  calcom: "Keep your Cal.com bookings and client records in sync.",
  google_calendar:
    "Import events from one Google Calendar. Tuts only reads your calendar.",
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
  businessId,
}: {
  api: Api;
  role: string;
  filter?: "all" | "calendars" | "crm";
  businessId?: string;
}) {
  const [connections, setConnections] = useState<Row[]>([]),
    [provider, setProvider] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(""),
    [secret, setSecret] = useState<Row | null>(null),
    [loading, setLoading] = useState(true);
  const [googleStatus, setGoogleStatus] = useState<{
    available: boolean;
    privateFeedAvailable?: boolean;
    reason?: string;
  } | null>(null);
  const [googleStatusError, setGoogleStatusError] = useState("");
  const [pendingCalendarId, setPendingCalendarId] = useState("");
  const [googleCalendars, setGoogleCalendars] = useState<Row[]>([]);
  const [googleCalendarsTruncated, setGoogleCalendarsTruncated] =
    useState(false);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [calendarRevision, setCalendarRevision] = useState(0);
  const [importAttendees, setImportAttendees] = useState(false);
  const [includeEventsWithoutAttendees, setIncludeEventsWithoutAttendees] =
    useState(true);
  const [googleDisplayName, setGoogleDisplayName] = useState("Google Calendar");
  const [showGoogleFeedForm, setShowGoogleFeedForm] = useState(false);
  const [googleFeedUrl, setGoogleFeedUrl] = useState("");
  const [googleFeedDisplayName, setGoogleFeedDisplayName] = useState("Google Calendar");
  const [googleFeedImportAttendees, setGoogleFeedImportAttendees] = useState(false);
  const [googleFeedIncludeWithoutAttendees, setGoogleFeedIncludeWithoutAttendees] = useState(true);
  const googleBusy = useRef(false);
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
        ? ["calendly", "calcom", "google_calendar"].includes(p)
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
  useEffect(() => {
    if (!canManage) {
      setGoogleStatus({ available: false, privateFeedAvailable: false, reason: "Ask your business administrator to connect Google Calendar." });
      return;
    }
    let current = true;
    const controller = new AbortController();
    api("integrations/v1/google-calendar/status", "GET", undefined, undefined, {
      signal: controller.signal,
      fresh: true,
    })
      .then((data) => {
        if (current) {
          setGoogleStatus(data);
          setGoogleStatusError("");
        }
      })
      .catch((cause) => {
        if (current && !controller.signal.aborted) {
          setGoogleStatus(null);
          setGoogleStatusError(errorMessage(cause));
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [api, canManage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const id = url.searchParams.get("googleCalendarConnection") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return;
    setPendingCalendarId(id);
    setImportAttendees(false);
    setIncludeEventsWithoutAttendees(true);
    setGoogleDisplayName("Google Calendar");
    url.searchParams.delete("googleCalendarConnection");
    window.history.replaceState(window.history.state, "", url);
  }, [businessId]);

  useEffect(() => {
    if (!pendingCalendarId) return;
    let current = true;
    const controller = new AbortController();
    setCalendarLoading(true);
    setCalendarError("");
    setGoogleCalendars([]);
    api(
      `integrations/v1/google-calendar/connections/${encodeURIComponent(pendingCalendarId)}/calendars`,
      "GET",
      undefined,
      undefined,
      { signal: controller.signal, fresh: true },
    )
      .then((data) => {
        if (!current) return;
        const items = Array.isArray(data.items) ? data.items : [];
        setGoogleCalendars(items);
        setGoogleCalendarsTruncated(Boolean(data.truncated));
        const primary = items.find((item: Row) => item.primary) ?? items[0];
        setCalendarId(primary?.id ?? "");
      })
      .catch((cause) => {
        if (current && !controller.signal.aborted)
          setCalendarError(errorMessage(cause));
      })
      .finally(() => {
        if (current) setCalendarLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [api, pendingCalendarId, calendarRevision]);

  async function startGoogleCalendar() {
    if (googleBusy.current || !canManage || !googleStatus?.available) return;
    googleBusy.current = true;
    setBusy("google-calendar");
    setGoogleStatusError("");
    setError("");
    try {
      const data = await api("integrations/v1/google-calendar/oauth/start", "POST", {
        displayName: "Google Calendar",
      });
      const target = new URL(data.authorizationUrl);
      if (
        target.protocol !== "https:" ||
        target.origin !== "https://accounts.google.com" ||
        target.pathname !== "/o/oauth2/v2/auth"
      )
        throw new Error("Google returned an unexpected authorization address. Refresh and try again.");
      window.location.assign(target.href);
    } catch (cause) {
      setGoogleStatusError(errorMessage(cause));
      googleBusy.current = false;
      setBusy("");
    }
  }

  async function selectGoogleCalendar() {
    if (!pendingCalendarId || !calendarId || busy || !canManage) return;
    setBusy("google-calendar-select");
    setCalendarError("");
    try {
      await api(
        `integrations/v1/google-calendar/connections/${encodeURIComponent(pendingCalendarId)}/select`,
        "POST",
        {
          calendarId,
          importAttendees,
          includeEventsWithoutAttendees,
          displayName: googleDisplayName.trim() || "Google Calendar",
        },
      );
      setPendingCalendarId("");
      setGoogleCalendars([]);
      setMessage("Calendar selected. Your events will start syncing shortly.");
      await load();
    } catch (cause) {
      setCalendarError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function connectGoogleFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || busy) return;
    let parsed: URL;
    try {
      parsed = new URL(googleFeedUrl);
    } catch {
      setCalendarError("Enter the private Google Calendar address in iCal format.");
      return;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== "https://calendar.google.com" ||
      !parsed.pathname.startsWith("/calendar/ical/")
    ) {
      setCalendarError("Use the private iCal address copied from Google Calendar settings.");
      return;
    }
    setBusy("google-calendar-feed");
    setCalendarError("");
    try {
      await api("integrations/v1/google-calendar/private-feed", "POST", {
        displayName: googleFeedDisplayName.trim() || "Google Calendar",
        calendarUrl: googleFeedUrl,
        importAttendees: googleFeedImportAttendees,
        includeEventsWithoutAttendees: googleFeedIncludeWithoutAttendees,
      });
      setShowGoogleFeedForm(false);
      setGoogleFeedUrl("");
      setGoogleFeedDisplayName("Google Calendar");
      setGoogleFeedImportAttendees(false);
      setGoogleFeedIncludeWithoutAttendees(true);
      setMessage("Google Calendar connected by private iCal link. Events will start syncing shortly.");
      await load();
    } catch (cause) {
      setCalendarError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
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
        `Received ${item.contactsReceived ?? 0} contacts and ${item.sessionsSynced ?? 0} sessions.${item.truncated ? " Some records still need review; see connector status." : ""}${typeof item.repair?.message === "string" ? ` ${item.repair.message}` : ""} Updates are processed in the background.`,
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
              ? "Connect your calendars."
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
              {p === "calendly" || p === "calcom" || p === "google_calendar" ? <BrandLogo brand={p} size={38} /> : <Plug size={25} />}
            </div>
            <h3>{names[p]}</h3>
            <p className="muted">{descriptions[p]}</p>
            <span className="setup-connector-requirement">
              {p === "google_calendar"
                ? googleStatus?.available
                  ? "Read-only access · Choose one calendar after connecting"
                  : googleStatus === null && googleStatusError
                    ? "Setup status could not be loaded"
                    : googleStatus?.privateFeedAvailable ? "Private calendar link available · Google sign-in setup pending" : "Google sign-in setup pending"
                : p === "calendly"
                ? "Personal access token required"
                : p === "calcom"
                  ? "API key required"
                  : p === "json_api"
                    ? "HTTPS contact endpoint required"
                    : "Server-side webhook setup"}
            </span>
            {p === "google_calendar" && googleStatusError && (
              <p className="small-note" role="status">{googleStatusError}</p>
            )}
            {p === "google_calendar" && googleStatus?.reason && (
              <p className="small-note">{googleStatus.reason}</p>
            )}
            <button
              className="primary"
              disabled={!canManage || (p === "google_calendar" && (googleStatus?.available !== true || !!busy))}
              onClick={() => {
                if (p === "google_calendar") {
                  void startGoogleCalendar();
                  return;
                }
                setProvider(p);
                setError("");
                setMapping({
                  externalId: "id",
                  displayName: "name",
                  email: "email",
                });
              }}
            >
              {p === "google_calendar" ? <CalendarDays size={16} /> : <Plus size={16} />}
              {p === "google_calendar"
                ? busy === "google-calendar" ? "Opening Google…" : "Connect Google Calendar"
                : `Connect ${names[p]}`}
            </button>
            {p === "google_calendar" && (
              <button
                type="button"
                disabled={!canManage || !!busy || !googleStatus?.privateFeedAvailable}
                onClick={() => {
                  setCalendarError("");
                  setShowGoogleFeedForm(true);
                }}
              >
                Connect with a private calendar link
              </button>
            )}
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
            Your connections will appear here. Calendars sync automatically;
            use Sync now whenever you need fresh data.
          </Empty>
        ) : (
          <div className="record-list">
            {visible.map((c) => (
              <div className="connection-record" key={c.id}>
                <div className="record-main">
                  <strong>{c.displayName}</strong>
                  {c.provider === "google_calendar" &&
                    (c.account?.summary || c.calendarSummary || c.selectedCalendarSummary || c.config?.calendarSummary) && (
                      <small>Calendar: {c.account?.summary || c.calendarSummary || c.selectedCalendarSummary || c.config.calendarSummary}</small>
                    )}
                  <small>
                    {names[c.provider]} ·{" "}
                    {c.provider === "google_calendar" && c.authMode === "ical" ? "Private iCal link · " : ""}
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
                  {c.provider === "google_calendar" && typeof c.syncCounts?.repair?.message === "string" && (
                    <p className="inline-error">{c.syncCounts.repair.message}</p>
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
                <span className={`status ${c.status}`}>{c.status === "awaiting_selection" ? "Choose a calendar" : c.status}</span>
                <div className="record-actions">
                  {c.provider === "google_calendar" && c.status === "awaiting_selection" && (
                    <button
                      disabled={!!busy || !canManage}
                      onClick={() => {
                        setCalendarError("");
                        setPendingCalendarId(c.id);
                      }}
                    >
                      <CalendarDays size={15} /> Choose calendar
                    </button>
                  )}
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
                  {c.provider !== "form_webhook" &&
                    !(c.provider === "google_calendar" && c.status === "awaiting_selection") && (
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
      {pendingCalendarId && (
        <Modal
          title="Choose a Google Calendar"
          onClose={() => setPendingCalendarId("")}
        >
          <p className="muted">
            Tuts reads events from one calendar. Recurring events are included and all-day events are skipped. Past events remain scheduled until you review attendance.
          </p>
          {calendarLoading ? (
            <Empty>Loading readable calendars…</Empty>
          ) : calendarError ? (
            <div>
              <Notice error={calendarError} />
              <button onClick={() => setCalendarRevision((revision) => revision + 1)}>
                <RefreshCw size={15} /> Try again
              </button>
            </div>
          ) : !googleCalendars.length ? (
            <Empty>No readable calendars were found for this Google account.</Empty>
          ) : (
            <>
              <label>
                Connection name
                <input
                  value={googleDisplayName}
                  onChange={(event) => setGoogleDisplayName(event.target.value)}
                  maxLength={100}
                />
              </label>
              <label>
                Calendar
                <select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>
                  {googleCalendars.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.summary || "Untitled calendar"}{calendar.primary ? " · Primary" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {calendarId && (() => {
                const chosen = googleCalendars.find((calendar) => calendar.id === calendarId);
                return chosen ? (
                  <p className="small-note">
                    {chosen.timeZone || "Calendar time zone not provided"} · {chosen.accessRole || "Read access"}
                  </p>
                ) : null;
              })()}
              {googleCalendarsTruncated && (
                <p className="small-note">Google returned a shortened calendar list. Select from the calendars shown here.</p>
              )}
              <label className="google-calendar-option">
                <input
                  type="checkbox"
                  checked={importAttendees}
                  onChange={(event) => setImportAttendees(event.target.checked)}
                />
                Import attendee contact details into my Tuts CRM
              </label>
              <label className="google-calendar-option">
                <input
                  type="checkbox"
                  checked={includeEventsWithoutAttendees}
                  onChange={(event) => setIncludeEventsWithoutAttendees(event.target.checked)}
                />
                Include events without attendees
              </label>
              <p className="small-note">
                Attendee import is optional. Imported events do not create bookings, invoices, or attendance records.
              </p>
            </>
          )}
          <div className="form-actions">
            <button
              type="button"
              disabled={busy === "google-calendar-select"}
              onClick={() => setPendingCalendarId("")}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={calendarLoading || !calendarId || !!calendarError || !canManage || busy === "google-calendar-select"}
              onClick={() => void selectGoogleCalendar()}
            >
              {busy === "google-calendar-select" ? "Saving…" : "Use this calendar"}
              <Check size={16} />
            </button>
          </div>
        </Modal>
      )}
      {showGoogleFeedForm && (
        <Modal
          title="Connect with a private calendar link"
          onClose={() => {
            if (busy !== "google-calendar-feed") {
              setShowGoogleFeedForm(false);
              setGoogleFeedUrl("");
              setCalendarError("");
            }
          }}
        >
          <div className="setup-connector-guide">
            <strong>Find the private iCal address in Google Calendar</strong>
            <ol>
              <li>Open Google Calendar settings and select the calendar you want to connect.</li>
              <li>Under “Integrate calendar,” copy its “Secret address in iCal format.”</li>
              <li>Paste it below. Keep this address private: anyone who has it can read that calendar.</li>
            </ol>
            <p>
              A Google Workspace administrator may disable private calendar links. If so, ask your administrator or use OAuth when it is configured.{" "}
              <a href="https://support.google.com/calendar/answer/37648" target="_blank" rel="noreferrer">
                Google Calendar help <ArrowUpRight size={12} />
              </a>
            </p>
          </div>
          <Notice error={calendarError} />
          <form onSubmit={(event) => void connectGoogleFeed(event)}>
            <label>
              Connection name
              <input
                value={googleFeedDisplayName}
                onChange={(event) => setGoogleFeedDisplayName(event.target.value)}
                maxLength={100}
              />
            </label>
            <label>
              Secret address in iCal format
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                value={googleFeedUrl}
                onChange={(event) => setGoogleFeedUrl(event.target.value)}
                placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              />
            </label>
            <label className="google-calendar-option">
              <input
                type="checkbox"
                checked={googleFeedImportAttendees}
                onChange={(event) => setGoogleFeedImportAttendees(event.target.checked)}
              />
              Import attendee contact details into my Tuts CRM
            </label>
            <label className="google-calendar-option">
              <input
                type="checkbox"
                checked={googleFeedIncludeWithoutAttendees}
                onChange={(event) => setGoogleFeedIncludeWithoutAttendees(event.target.checked)}
              />
              Include events without attendees
            </label>
            <p className="small-note">Attendee import is optional. Imported events do not create bookings, invoices, or attendance records.</p>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy === "google-calendar-feed"}
                onClick={() => {
                  setShowGoogleFeedForm(false);
                  setGoogleFeedUrl("");
                  setCalendarError("");
                }}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy === "google-calendar-feed"}>
                {busy === "google-calendar-feed" ? "Connecting…" : "Connect calendar"}
                <Check size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
