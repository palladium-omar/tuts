import { createHash } from "node:crypto";
import { contactSchema, type Contact, type ExternalSession } from "./schemas.js";
import { ConnectorError } from "./security.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;
export type GoogleCalendarCredentials = {
  accessToken: string;
  refreshToken: string;
  /** Unix milliseconds, consistent with Date.now(). */
  expiresAt: number;
  scope: string;
};
export type GoogleCalendarConfig = {
  calendarId?: string;
  importAttendees?: boolean;
  includeEventsWithoutAttendees?: boolean;
};
export type GoogleCalendarItem = {
  id: string;
  summary: string;
  primary: boolean;
  timeZone?: string;
  accessRole: string;
};
export type GoogleCalendarSyncData = {
  contacts: Contact[];
  sessions: ExternalSession[];
  truncated: boolean;
  skippedEvents: number;
  /** OAuth requires explicit cancellations; a complete private feed can reconcile absence. */
  cancelledIds: string[];
};
/** Integrations-owned storage only. Never include this wrapper in domain events or API views. */
export type GoogleCalendarSnapshot = {
  session: ExternalSession;
  googleEventId?: string;
  repairCheckedAt?: string;
};
export type GoogleCalendarOAuthSyncData = GoogleCalendarSyncData & {
  privateSnapshots: GoogleCalendarSnapshot[];
  repair: { checked: number; pending: number; unresolved: number; missingProviderIds: number; message?: string };
};

const API_BASE = "https://www.googleapis.com/calendar/v3/";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 2000;
const MAX_PAGES = 10;
const PULL_BUDGET_MS = 18000;
type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const identifier = (value: unknown, max = 1024): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const token = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\s\u0000-\u001f\u007f]/.test(value);
const timestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};
function email(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return contactSchema.shape.email.safeParse(normalized).success ? normalized : undefined;
}
function requiredScopes(scope: unknown): scope is string {
  if (typeof scope !== "string" || scope.length > 4096) return false;
  const granted = new Set(scope.split(/\s+/));
  return GOOGLE_CALENDAR_SCOPES.every((required) => granted.has(required));
}
function validateCredentials(credentials: GoogleCalendarCredentials) {
  if (!credentials || !token(credentials.accessToken) || !token(credentials.refreshToken) ||
      !Number.isFinite(credentials.expiresAt) || !requiredScopes(credentials.scope))
    throw new ConnectorError("Google Calendar credentials are invalid; reconnect the calendar");
}

/** Fixed Google endpoints only, no redirects, no provider bodies in errors or logs. */
async function googleJson(url: URL, init: RequestInit, deadline = Date.now() + 15000): Promise<JsonObject> {
  const apiGet = url.origin === "https://www.googleapis.com" && url.pathname.startsWith("/calendar/v3/") && init.method === "GET";
  const tokenPost = url.toString() === TOKEN_URL && init.method === "POST";
  if (url.username || url.password || url.hash || (!apiGet && !tokenPost))
    throw new ConnectorError("Google Calendar endpoint is invalid");
  const remaining = Math.min(15000, deadline - Date.now());
  if (remaining <= 0) throw new ConnectorError("Google Calendar request timed out");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  let stage: "request" | "response" = "request";
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal,
      headers: { Accept: "application/json", ...init.headers } });
    stage = "response";
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      if (response.status >= 300 && response.status < 400)
        throw new ConnectorError("Google Calendar redirects are not allowed");
      if (response.status === 401)
        throw new ConnectorError("Google Calendar authorization expired or was revoked; reconnect the calendar");
      if (response.status === 403)
        throw new ConnectorError("Google Calendar denied access; check the granted permissions and Calendar API configuration");
      if (response.status === 429)
        throw new ConnectorError("Google Calendar request limit was reached; try again shortly");
      if (tokenPost && response.status === 400)
        throw new ConnectorError("Google Calendar authorization could not be completed; reconnect the calendar");
      throw new ConnectorError(`Google Calendar request failed (HTTP ${response.status})`);
    }
    if (!response.body) throw new ConnectorError("Google Calendar returned invalid JSON");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new ConnectorError("Google Calendar response exceeded 2 MB");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ConnectorError("Google Calendar returned invalid JSON"); }
    if (!object(body)) throw new ConnectorError("Google Calendar returned invalid JSON");
    return body;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(controller.signal.aborted ? "Google Calendar request timed out" :
      stage === "response" ? "Google Calendar response was interrupted" : "Google Calendar connection failed");
  } finally { clearTimeout(timer); }
}
function oauthClient() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new ConnectorError("Google Calendar OAuth is not configured");
  return { client_id: clientId, client_secret: clientSecret };
}
function credentialsFromResponse(body: JsonObject, previous?: GoogleCalendarCredentials): GoogleCalendarCredentials {
  const refreshToken = body.refresh_token ?? previous?.refreshToken;
  const scope = body.scope ?? previous?.scope;
  if (!token(body.access_token) || !token(refreshToken) || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer" ||
      !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 604800)
    throw new ConnectorError("Google Calendar did not issue usable offline credentials; reconnect and grant offline access");
  if (!requiredScopes(scope))
    throw new ConnectorError("Grant both Google Calendar event and calendar list read permissions to connect");
  return { accessToken: body.access_token, refreshToken, expiresAt: Date.now() + body.expires_in * 1000, scope };
}
export async function exchangeGoogleCode(code: string, verifier: string, redirectUri: string): Promise<GoogleCalendarCredentials> {
  if (!identifier(code, 8192) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !redirectUri || redirectUri !== process.env.GOOGLE_CALENDAR_REDIRECT_URI)
    throw new ConnectorError("Google Calendar authorization request is invalid");
  const form = new URLSearchParams({ ...oauthClient(), grant_type: "authorization_code", code,
    code_verifier: verifier, redirect_uri: redirectUri });
  return credentialsFromResponse(await googleJson(new URL(TOKEN_URL), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
  }));
}
export async function refreshGoogleCredentials(credentials: GoogleCalendarCredentials, deadline = Date.now() + 5000): Promise<GoogleCalendarCredentials> {
  validateCredentials(credentials);
  const form = new URLSearchParams({ ...oauthClient(), grant_type: "refresh_token", refresh_token: credentials.refreshToken });
  return credentialsFromResponse(await googleJson(new URL(TOKEN_URL), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
  }, deadline), credentials);
}
function auth(credentials: GoogleCalendarCredentials) {
  validateCredentials(credentials);
  return { Authorization: `Bearer ${credentials.accessToken}` };
}
function nextPage(body: JsonObject): string | undefined {
  if (body.nextPageToken === undefined || body.nextPageToken === "") return undefined;
  const next = identifier(body.nextPageToken, 8192);
  if (!next) throw new ConnectorError("Google Calendar pagination response was invalid");
  return next;
}
export async function listGoogleCalendars(credentials: GoogleCalendarCredentials, deadline = Date.now() + PULL_BUDGET_MS): Promise<{ items: GoogleCalendarItem[]; truncated: boolean }> {
  const headers = auth(credentials);
  const items = new Map<string, GoogleCalendarItem>();
  let next: string | undefined, count = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (deadline - Date.now() < 100) return { items: [...items.values()], truncated: true };
    const url = new URL("users/me/calendarList", API_BASE);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("minAccessRole", "reader");
    if (next) url.searchParams.set("pageToken", next);
    let body: JsonObject;
    try { body = await googleJson(url, { method: "GET", headers }, deadline); }
    catch (error) {
      if (count && error instanceof ConnectorError && error.safeMessage === "Google Calendar request timed out" && Date.now() >= deadline)
        return { items: [...items.values()], truncated: true };
      throw error;
    }
    const records: unknown = body.items ?? [];
    if (!Array.isArray(records)) throw new ConnectorError("Google Calendar calendar list response was invalid");
    for (const item of records) {
      if (++count > MAX_RECORDS) return { items: [...items.values()], truncated: true };
      if (!object(item)) throw new ConnectorError("Google Calendar calendar list response was invalid");
      const id = identifier(item.id), summary = text(item.summaryOverride ?? item.summary, 200);
      if (!id || !summary) throw new ConnectorError("Google Calendar calendar list response was invalid");
      if (!["reader", "writerWithoutPrivateAccess", "writer", "owner"].includes(item.accessRole) || item.deleted === true) continue;
      items.set(id, { id, summary, primary: item.primary === true, timeZone: text(item.timeZone, 100), accessRole: item.accessRole });
    }
    next = nextPage(body);
    if (!next) return { items: [...items.values()], truncated: false };
  }
  return { items: [...items.values()], truncated: true };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Hash complete IDs instead of truncating them, including calendar scope for shared events. */
function sessionId(calendarId: string, eventId: string) {
  return `google-calendar:${hash(calendarId)}:${hash(eventId)}`;
}
function googleEventLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const calendarLink = url.origin === "https://calendar.google.com" && url.pathname.startsWith("/calendar/");
    const legacyEventLink = url.origin === "https://www.google.com" && url.pathname === "/calendar/event";
    return (calendarLink || legacyEventLink) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

export async function pullGoogleCalendar(
  credentials: GoogleCalendarCredentials,
  config: GoogleCalendarConfig,
  priorSessions: readonly ExternalSession[] = [],
  deadline = Date.now() + PULL_BUDGET_MS,
  priorSnapshots: readonly GoogleCalendarSnapshot[] = [],
): Promise<GoogleCalendarOAuthSyncData> {
  const calendarId = identifier(config.calendarId);
  if (!calendarId) throw new ConnectorError("Choose a readable Google Calendar before synchronizing");
  const headers = auth(credentials), now = Date.now();
  const observedAt = new Date(now).toISOString();
  const result: GoogleCalendarSyncData = { contacts: [], sessions: [], truncated: false, skippedEvents: 0, cancelledIds: [] };
  const contacts = new Map<string, Contact>(), sessions = new Map<string, ExternalSession>();
  const prior = new Map(priorSessions.map((session) => [session.externalId, session]));
  const cancelled = new Set<string>();
  const present = new Set<string>(), snapshots = new Map<string, GoogleCalendarSnapshot>();
  const previousSnapshots = new Map(priorSnapshots.map((item) => [item.session.externalId, item]));
  const repair: GoogleCalendarOAuthSyncData["repair"] = { checked: 0, pending: 0, unresolved: 0, missingProviderIds: 0 };
  const finish = (): GoogleCalendarOAuthSyncData => ({ ...result, contacts: [...contacts.values()], sessions: [...sessions.values()],
    cancelledIds: [...cancelled], privateSnapshots: [...snapshots.values()], repair });
  const normalize = (event: JsonObject): ExternalSession | undefined => {
    const id = identifier(event.id);
    if (!id) { result.skippedEvents++; return undefined; }
    const externalId = sessionId(calendarId, id), previous = prior.get(externalId);
    present.add(externalId);
    const unsupported = () => {
      result.skippedEvents++;
      if (previous && previous.status !== "cancelled") repair.unresolved++;
      return undefined;
    };
    const updated = timestamp(event.updated);
    const revision = { providerUpdatedAt: updated, providerObservedAt: observedAt,
      revisionSource: updated ? "provider" as const : "observed" as const };
    let normalized: ExternalSession | undefined;
    if (event.status === "cancelled") {
      cancelled.add(externalId);
      if (previous) normalized = { ...previous, status: "cancelled", ...revision };
    }
    if (!normalized) {
      if (event.eventType !== undefined && event.eventType !== "default") return unsupported();
      const startsAt = timestamp(event.start?.dateTime), endsAt = timestamp(event.end?.dateTime), title = text(event.summary, 200);
      if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt) || !title ||
          (["private", "confidential"].includes(event.visibility) && /^busy$/i.test(title))) return unsupported();
      const attendees = Array.isArray(event.attendees) ? event.attendees.filter((attendee: unknown) =>
        object(attendee) && attendee.self !== true && attendee.resource !== true && attendee.responseStatus !== "declined") : [];
      if (!attendees.length && config.includeEventsWithoutAttendees === false && event.status !== "cancelled") { result.skippedEvents++; return undefined; }
      const sole = event.attendeesOmitted !== true && attendees.length === 1 &&
        !attendees[0].additionalGuests && !attendees[0].asyncOperation ? attendees[0] : undefined;
      normalized = { externalId, title, startsAt, endsAt, status: event.status === "cancelled" ? "cancelled" : "scheduled",
        attendeeName: sole ? text(sole.displayName, 160) ?? email(sole.email) : undefined,
        attendeeEmail: sole ? email(sole.email) : undefined, bookingUrl: googleEventLink(event.htmlLink), ...revision };
      if (config.importAttendees === true && event.status !== "cancelled") for (const attendee of attendees) {
        const address = email(attendee.email);
        if (!address) continue;
        if (contacts.size >= MAX_RECORDS && !contacts.has(address)) { result.truncated = true; break; }
        contacts.set(address, { externalId: `google-attendee:${address}`, email: address,
          displayName: text(attendee.displayName, 160) ?? address.slice(0, 160) });
      }
    }
    if (sessions.size >= MAX_RECORDS && !sessions.has(externalId)) { result.truncated = true; return undefined; }
    sessions.set(externalId, normalized);
    snapshots.set(externalId, { session: normalized, googleEventId: id, repairCheckedAt: observedAt });
    return normalized;
  };
  let next: string | undefined, count = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (deadline - Date.now() < 100) { result.truncated = true; break; }
    const url = new URL(`calendars/${encodeURIComponent(calendarId)}/events`, API_BASE);
    url.searchParams.set("timeMin", new Date(now - 90 * 86400000).toISOString());
    url.searchParams.set("timeMax", new Date(now + 180 * 86400000).toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("maxResults", String(Math.min(250, MAX_RECORDS - count)));
    if (next) url.searchParams.set("pageToken", next);
    let body: JsonObject;
    try { body = await googleJson(url, { method: "GET", headers }, deadline); }
    catch (error) {
      if (count && error instanceof ConnectorError && error.safeMessage === "Google Calendar request timed out" && Date.now() >= deadline) {
        result.truncated = true; break;
      }
      throw error;
    }
    const records: unknown = body.items ?? [];
    if (!Array.isArray(records)) throw new ConnectorError("Google Calendar events response was invalid");
    for (const event of records) {
      if (count++ >= MAX_RECORDS) { result.truncated = true; return finish(); }
      if (!object(event)) { result.skippedEvents++; continue; }
      normalize(event);
    }
    next = nextPage(body);
    if (!next) break;
    if (count >= MAX_RECORDS) { result.truncated = true; break; }
    if (page === MAX_PAGES - 1) result.truncated = true;
  }
  // A bounded window list cannot distinguish moved events from deleted or inaccessible events.
  // Re-fetch only known identities, and trust canonical returned status rather than absence/HTTP errors.
  if (!result.truncated) {
    const min = now - 90 * 86400000, max = now + 180 * 86400000;
    const absent = priorSessions.filter((item) => item.status !== "cancelled" && Date.parse(item.endsAt) > min &&
      Date.parse(item.startsAt) < max && !present.has(item.externalId));
    const candidates: GoogleCalendarSnapshot[] = [];
    for (const item of absent) {
      const snapshot = previousSnapshots.get(item.externalId), eventId = identifier(snapshot?.googleEventId);
      if (!eventId || sessionId(calendarId, eventId) !== item.externalId) { repair.missingProviderIds++; continue; }
      candidates.push({ ...snapshot!, session: item });
    }
    candidates.sort((a, b) => (Date.parse(a.repairCheckedAt ?? "") || 0) - (Date.parse(b.repairCheckedAt ?? "") || 0) ||
      a.session.externalId.localeCompare(b.session.externalId));
    let attempted = 0;
    for (let offset = 0; offset < Math.min(20, candidates.length); offset += 4) {
      if (deadline - Date.now() < 100 || sessions.size >= MAX_RECORDS) break;
      const batch = candidates.slice(offset, Math.min(offset + 4, 20));
      // Fetches run concurrently; normalization and cap checks remain sequential.
      const fetched = await Promise.allSettled(batch.map((snapshot) => googleJson(
        new URL(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(snapshot.googleEventId!)}`, API_BASE),
        { method: "GET", headers }, deadline)));
      for (let index = 0; index < batch.length; index++) {
        const snapshot = batch[index]!, response = fetched[index]!;
        attempted++; repair.checked++;
        snapshots.set(snapshot.session.externalId, { ...snapshot, repairCheckedAt: observedAt });
        if (response.status !== "fulfilled" || response.value.id !== snapshot.googleEventId) repair.unresolved++;
        else {
          const before = repair.unresolved;
          if (!normalize(response.value) && repair.unresolved === before) repair.unresolved++;
        }
      }
    }
    repair.pending = candidates.length - attempted;
    if (repair.pending || repair.unresolved || repair.missingProviderIds) {
      result.truncated = true;
      repair.message = repair.missingProviderIds
        ? "Some older imported records lack provider IDs. Review their dates and attendance manually; automatic repair can resume if Google returns those events in the calendar window."
        : repair.unresolved
        ? "Some imported events could not be verified. Previous dates and status were preserved; check Google Calendar access, review those events, and retry sync."
        : "More imported events need verification. Sync again or wait for the next scheduled sync before reviewing attendance.";
    }
  }
  return finish();
}
