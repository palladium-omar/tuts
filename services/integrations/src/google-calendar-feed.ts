import ICAL from "ical.js";
import { createHash } from "node:crypto";
import { contactSchema, type Contact, type ExternalSession } from "./schemas.js";
import { ConnectorError } from "./security.js";
import type { GoogleCalendarConfig, GoogleCalendarSyncData } from "./google-calendar-provider.js";

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;
type CalendarEvent = InstanceType<typeof ICAL.Event>;
const DAY = 86400000;
const MAX_EVENTS = 2000;
const MAX_ITERATIONS = 20000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clean = (value: unknown, max = 200): string | undefined => typeof value === "string" && value.trim()
  ? value.trim().replace(/private-[a-f\d]{16,128}/gi, "[private calendar link]").slice(0, max) : undefined;
const prop = (component: Component, name: string): unknown => component.getFirstPropertyValue(name);
function address(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.replace(/^mailto:/i, "").trim().toLowerCase();
  return contactSchema.shape.email.safeParse(candidate).success ? candidate : undefined;
}

/** Accept only Google's exact feed route; never accept a caller-selected host or redirect. */
export function validateGoogleCalendarFeedUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new ConnectorError("Use the Google Calendar iCal address from Integrate calendar settings"); }
  if (input.length > 2048 || !/^https:\/\/calendar\.google\.com\//i.test(input) || /[\u0000-\u0020\u007f]/.test(input) || url.origin !== "https://calendar.google.com" ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/calendar\/ical\/[^/]{1,960}\/(?:private-[a-fA-F\d]{16,128}|public)\/basic\.ics$/.test(url.pathname))
    throw new ConnectorError("Use the Google Calendar iCal address from Integrate calendar settings");
  googleCalendarFeedId(url);
  return url;
}
export function googleCalendarFeedId(url: URL): string {
  let id: string;
  try { id = decodeURIComponent(url.pathname.split("/")[3] ?? ""); }
  catch { throw new ConnectorError("Google Calendar iCal address contains an invalid calendar identifier"); }
  if (!id || id.length > 320 || /[\u0000-\u0020\u007f/\\]/.test(id))
    throw new ConnectorError("Google Calendar iCal address contains an invalid calendar identifier");
  return id;
}
async function fetchFeed(url: URL, deadline: number): Promise<string> {
  const remaining = Math.min(15000, deadline - Date.now());
  if (remaining <= 0) throw new ConnectorError("Google Calendar feed request timed out");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
  let reading = false;
  try {
    const response = await fetch(url, { headers: { Accept: "text/calendar" }, redirect: "manual", signal: controller.signal });
    reading = true;
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      if (response.status >= 300 && response.status < 400) throw new ConnectorError("Google Calendar feed redirects are not allowed");
      if ([401, 403, 404].includes(response.status)) throw new ConnectorError("Google Calendar feed is unavailable; check or reset its iCal address");
      throw new ConnectorError(`Google Calendar feed request failed (HTTP ${response.status})`);
    }
    if (!response.body) throw new ConnectorError("Google Calendar returned an empty feed");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          try { await reader.cancel(); } catch {}
          throw new ConnectorError("Google Calendar feed exceeded 2 MB; use a smaller calendar or OAuth");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(controller.signal.aborted ? "Google Calendar feed request timed out" :
      reading ? "Google Calendar feed response was interrupted" : "Google Calendar feed connection failed");
  } finally { clearTimeout(timer); }
}

export type GoogleCalendarFeedData = GoogleCalendarSyncData & { calendarName?: string; timeZone?: string };
/** Pure JS parsing, using the calendar component's timezone cache; never mutate TimezoneService. */
export async function pullGoogleCalendarFeed(
  calendarUrl: string,
  config: GoogleCalendarConfig,
  priorSessions: readonly ExternalSession[] = [],
  deadline = Date.now() + 18000,
): Promise<GoogleCalendarFeedData> {
  const url = validateGoogleCalendarFeedUrl(calendarUrl), calendarId = googleCalendarFeedId(url);
  if (config.calendarId && config.calendarId !== calendarId) throw new ConnectorError("Google Calendar feed does not match this connection");
  const now = Date.now(), min = now - 90 * DAY, max = now + 180 * DAY;
  const observedAt = new Date(now).toISOString();
  const raw = await fetchFeed(url, deadline);
  const sessions = new Map<string, ExternalSession>(), contacts = new Map<string, Contact>(), cancelled = new Set<string>();
  const present = new Set<string>(), protectedPrefixes = new Set<string>();
  const prior = new Map(priorSessions.map((item) => [item.externalId, item]));
  let truncated = false, skippedEvents = 0, iterations = 0, completeIdentities = true;
  const budget = () => {
    if (Date.now() >= deadline) throw new ConnectorError("Google Calendar feed processing timed out; use a smaller calendar or OAuth");
    if (++iterations > MAX_ITERATIONS) throw new ConnectorError("Google Calendar feed recurrence budget exceeded; use a smaller calendar or OAuth");
  };
  try {
    budget();
    if (!/^BEGIN:VCALENDAR\r?\n/i.test(raw.replace(/^\uFEFF/, ""))) throw new ConnectorError("Google Calendar returned an invalid calendar feed");
    const calendar = new ICAL.Component(ICAL.parse(raw));
    if (calendar.name !== "vcalendar") throw new ConnectorError("Google Calendar returned an invalid calendar feed");
    const components = calendar.getAllSubcomponents("vevent");
    if (components.length > 10000) throw new ConnectorError("Google Calendar feed contains too many events; use a smaller calendar or OAuth");
    const zones = calendar.getAllSubcomponents("vtimezone");
    if (zones.length > 32) throw new ConnectorError("Google Calendar feed contains too many timezone definitions; use OAuth");
    for (const zone of zones) {
      const transitions = zone.getAllSubcomponents();
      if (transitions.length > 128) throw new ConnectorError("Google Calendar feed timezone definition is too complex; use OAuth");
      for (const transition of transitions) {
        const start = prop(transition, "dtstart");
        if (!(start instanceof ICAL.Time) || start.year < 1900 || start.year > 2100)
          throw new ConnectorError("Google Calendar feed timezone definition is unsupported; use OAuth");
        for (const ruleProperty of transition.getAllProperties("rrule")) {
          const rule = ruleProperty.getFirstValue() as InstanceType<typeof ICAL.Recur>;
          if (rule.freq !== "YEARLY" || Object.values(rule.parts).some((values) => values.length > 31) ||
              rule.parts.BYSECOND || rule.parts.BYMINUTE || rule.parts.BYHOUR)
            throw new ConnectorError("Google Calendar feed timezone recurrence is unsupported; use OAuth");
        }
      }
    }
    const defaultZone = clean(prop(calendar, "x-wr-timezone"), 100);
    // A missing zone is refused rather than interpreted in the server's local zone or UTC.
    const prepare = (component: Component) => {
      for (const name of ["dtstart", "dtend", "recurrence-id", "exdate", "rdate", "last-modified"]) {
        for (const property of component.getAllProperties(name)) {
          if (property.type === "period") throw new ConnectorError("Google Calendar feed RDATE periods are unsupported; use OAuth");
          for (const value of property.getValues()) {
            if (!(value instanceof ICAL.Time) || value.isDate || value.zone === ICAL.Timezone.utcTimezone) continue;
            const zoneId = property.getParameter("tzid") || defaultZone;
            const zone = typeof zoneId === "string" ? calendar.getTimeZoneByID(zoneId) : null;
            if (!zone) throw new ConnectorError("Google Calendar feed has a floating or undefined timezone; use a feed with VTIMEZONE definitions or OAuth");
            value.zone = zone;
          }
        }
      }
    };
    const ms = (time: Time) => {
      if (!(time instanceof ICAL.Time) || time.isDate || time.zone === ICAL.Timezone.localTimezone)
        throw new ConnectorError("Google Calendar feed event time is unavailable or has an undefined timezone");
      const value = time.toUnixTime() * 1000;
      if (!Number.isFinite(value)) throw new ConnectorError("Google Calendar feed event time is invalid");
      return value;
    };
    const revision = (component: Component) => {
      const value = prop(component, "last-modified");
      return value instanceof ICAL.Time && !value.isDate ?
        { providerUpdatedAt: new Date(ms(value)).toISOString(), providerObservedAt: observedAt, revisionSource: "provider" as const } :
        { providerUpdatedAt: undefined, providerObservedAt: observedAt, revisionSource: "observed" as const };
    };
    const prefix = (uid: string) => `google-ical:${hash(calendarId)}:${hash(uid)}:`;
    const key = (uid: string, recurrence?: Time) => `${prefix(uid)}${hash(recurrence ? new Date(ms(recurrence)).toISOString() : "single")}`;
    const cancel = (id: string, component: Component) => {
      if (cancelled.size >= MAX_EVENTS && !cancelled.has(id)) { truncated = true; return; }
      const previous = prior.get(id);
      if (previous && sessions.size >= MAX_EVENTS && !sessions.has(id)) { truncated = true; return; }
      cancelled.add(id);
      if (previous) sessions.set(id, { ...previous, status: "cancelled", ...revision(component) });
      else skippedEvents++;
    };
    const project = (event: CalendarEvent, start: Time, end: Time, recurrence?: Time) => {
      budget();
      const id = key(event.uid, recurrence), component = event.component;
      // Presence is independent of attendee import, title and appointment filters.
      present.add(id);
      if (String(prop(component, "status")).toUpperCase() === "CANCELLED") { cancel(id, component); return; }
      const startMs = ms(start), endMs = ms(end);
      // A known event moved beyond the import window must update its old projected slot.
      // The window limits discovery of new events, not corrections to imported identities.
      if ((endMs <= min || startMs >= max) && !prior.has(id)) return;
      const title = clean(event.summary), type = clean(prop(component, "x-google-event-type"));
      if (endMs <= startMs || !title || (type && type !== "default") ||
          (["PRIVATE", "CONFIDENTIAL"].includes(String(prop(component, "class")).toUpperCase()) && /^busy$/i.test(title))) { skippedEvents++; return; }
      const organizer = address(event.organizer);
      const attendees = event.attendees.filter((attendee) => {
        const mail = address(attendee.getFirstValue()), resource = String(attendee.getParameter("cutype")).toUpperCase();
        return mail && mail !== calendarId.toLowerCase() && mail !== organizer &&
          !["RESOURCE", "ROOM"].includes(resource) && String(attendee.getParameter("partstat")).toUpperCase() !== "DECLINED";
      });
      if (!attendees.length && config.includeEventsWithoutAttendees === false) { skippedEvents++; return; }
      if (sessions.size >= MAX_EVENTS && !sessions.has(id)) { truncated = true; return; }
      const sole = attendees.length === 1 &&
        ["", "INDIVIDUAL"].includes(String(attendees[0].getParameter("cutype") ?? "").toUpperCase()) &&
        !attendees[0].getParameter("member") ? attendees[0] : undefined;
      sessions.set(id, { externalId: id, title, startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), status: "scheduled",
        attendeeName: sole ? clean(sole.getParameter("cn"), 160) ?? address(sole.getFirstValue()) : undefined,
        attendeeEmail: sole ? address(sole.getFirstValue()) : undefined,
        bookingUrl: "https://calendar.google.com/calendar/u/0/r", ...revision(component) });
      if (config.importAttendees === true) for (const attendee of attendees) {
        const mail = address(attendee.getFirstValue())!;
        if (contacts.size >= MAX_EVENTS && !contacts.has(mail)) { truncated = true; break; }
        contacts.set(mail, { externalId: `google-attendee:${mail}`, email: mail, displayName: clean(attendee.getParameter("cn"), 160) ?? mail.slice(0, 160) });
      }
    };
    const groups = new Map<string, Component[]>();
    for (const component of components) {
      budget();
      const uid = prop(component, "uid");
      if (typeof uid !== "string" || !uid || uid.length > 2048) { skippedEvents++; completeIdentities = false; truncated = true; continue; }
      prepare(component);
      if (component.getFirstProperty("recurrence-id")?.getParameter("range"))
        throw new ConnectorError("Google Calendar feed recurrence range overrides are unsupported; use OAuth");
      const entries = groups.get(uid) ?? []; entries.push(component); groups.set(uid, entries);
    }
    for (const [uid, entries] of groups) {
      budget();
      const masters = entries.filter((item) => !item.hasProperty("recurrence-id"));
      if (masters.length > 1) throw new ConnectorError("Google Calendar feed has ambiguous duplicate event identities");
      const overrides = entries.filter((item) => {
        if (!item.hasProperty("recurrence-id")) return false;
        if ((prop(item, "recurrence-id") as Time)?.isDate) { skippedEvents++; protectedPrefixes.add(prefix(uid)); return false; }
        return true;
      });
      const overrideKeys = new Set(overrides.map((item) => key(uid, prop(item, "recurrence-id") as Time)));
      for (const override of overrides) {
        const recurrence = prop(override, "recurrence-id") as Time;
        present.add(key(uid, recurrence));
        if (String(prop(override, "status")).toUpperCase() === "CANCELLED") cancel(key(uid, recurrence), override);
        else if ((prop(override, "dtstart") as Time)?.isDate) { skippedEvents++; protectedPrefixes.add(prefix(uid)); }
        else if (override.hasProperty("dtstart")) {
          const event = new ICAL.Event(override, { exceptions: [] }); project(event, event.startDate, event.endDate, recurrence);
        } else { skippedEvents++; protectedPrefixes.add(prefix(uid)); }
      }
      const master = masters[0];
      if (!master) continue;
      if (String(prop(master, "status")).toUpperCase() === "CANCELLED") {
        for (const [id] of prior) if (id.startsWith(prefix(uid))) cancel(id, master);
        if (!master.hasProperty("rrule")) cancel(key(uid), master);
        continue;
      }
      const start = prop(master, "dtstart");
      if (!(start instanceof ICAL.Time) || start.isDate) { skippedEvents++; protectedPrefixes.add(prefix(uid)); continue; }
      const event = new ICAL.Event(master, { exceptions: [] });
      if (!event.isRecurring()) { project(event, event.startDate, event.endDate); continue; }
      if (master.hasProperty("exrule") || master.getAllProperties("rrule").length > 1)
        throw new ConnectorError("Google Calendar feed has unsupported recurrence rules; use OAuth");
      const rules = master.getAllProperties("rrule").map((item) => item.getFirstValue() as InstanceType<typeof ICAL.Recur>);
      for (const rule of rules) {
        if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq) ||
            !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000 ||
            Object.values(rule.parts).some((values) => values.length > 31) ||
            Object.keys(rule.parts).some((part) => !["BYDAY", "BYMONTHDAY", "BYMONTH"].includes(part)) ||
            (rule.parts.BYDAY && rule.parts.BYMONTHDAY) ||
            (rule.parts.BYDAY?.some((value) => !/^(?:[+-]?[1-5])?(?:MO|TU|WE|TH|FR|SA|SU)$/.test(String(value)))) ||
            (rule.parts.BYMONTH?.some((value) => Number(value) < 1 || Number(value) > 12)) ||
            (rule.parts.BYMONTHDAY?.some((value) => !Number.isInteger(Number(value)) || Number(value) === 0 || Math.abs(Number(value)) > 31)) ||
            (rule.parts.BYMONTH && rule.parts.BYMONTHDAY?.some((value) => Math.abs(Number(value)) > 28)))
          throw new ConnectorError("Google Calendar feed has a high-frequency or unsupported recurrence; use OAuth");
      }
      // Fast-forward common uncounted daily/weekly rules by whole intervals, preserving their anchor.
      // Low-frequency complex rules may walk at most thirty years under the shared iteration budget.
      let iteratorStart = event.startDate;
      if (ms(iteratorStart) < min - 366 * DAY && rules.length) {
        const rule = rules[0];
        const parts = Object.keys(rule.parts);
        const weeklyDays = rule.parts.BYDAY;
        const anchoredWeekly = rule.freq === "WEEKLY" && parts.every((part) => part === "BYDAY") &&
          (!weeklyDays || (weeklyDays.length <= 7 && weeklyDays.every((value) => /^(?:MO|TU|WE|TH|FR|SA|SU)$/.test(String(value))) &&
            weeklyDays.includes(ICAL.Recur.numericDayToIcalDay(iteratorStart.dayOfWeek()))));
        const simpleDaily = rule.freq === "DAILY" && !parts.length;
        if (!rule.count && (simpleDaily || anchoredWeekly)) {
          const days = rule.interval * (rule.freq === "WEEKLY" ? 7 : 1);
          const margin = rule.freq === "WEEKLY" ? 14 * DAY : 2 * DAY;
          const steps = Math.max(0, Math.floor((min - margin - ms(iteratorStart)) / (days * DAY)));
          iteratorStart = iteratorStart.clone(); iteratorStart.adjust(steps * days, 0, 0, 0);
        } else if (rule.freq === "DAILY" || ms(iteratorStart) < min - 30 * 366 * DAY) {
          throw new ConnectorError("Google Calendar feed has an old complex recurrence; use OAuth or recreate that recurring series");
        }
      }
      for (const property of master.getAllProperties("exdate")) for (const date of property.getValues()) {
        if (date instanceof ICAL.Time && !date.isDate) {
          const id = key(uid, date);
          if (!overrideKeys.has(id) && prior.has(id)) cancel(id, master);
        }
      }
      const expansion = event.iterator(iteratorStart);
      while (true) {
        budget();
        const occurrence = expansion.next();
        if (!occurrence || ms(occurrence) >= max) break;
        if (overrideKeys.has(key(uid, occurrence))) continue;
        const details = event.getOccurrenceDetails(occurrence);
        project(event, details.startDate, details.endDate, occurrence);
        if (truncated && sessions.size >= MAX_EVENTS) break;
      }
      if (truncated && sessions.size >= MAX_EVENTS) break;
    }
    budget();
    // Google publishes a full ICS snapshot. Only a fully evaluated snapshot proves absence.
    // Preserve prior sessions outside the window and groups whose identities could not be evaluated.
    if (!truncated && completeIdentities) {
      const inferred = priorSessions.filter((item) => item.status !== "cancelled" &&
        item.externalId.startsWith(`google-ical:${hash(calendarId)}:`) &&
        Date.parse(item.endsAt) > min && Date.parse(item.startsAt) < max &&
        !present.has(item.externalId) && !cancelled.has(item.externalId) &&
        !protectedPrefixes.has(item.externalId.slice(0, item.externalId.lastIndexOf(":") + 1)));
      const additional = inferred.filter((item) => !sessions.has(item.externalId));
      if (sessions.size + additional.length > MAX_EVENTS || cancelled.size + inferred.length > MAX_EVENTS) truncated = true;
      else for (const previous of inferred) {
        cancelled.add(previous.externalId);
        sessions.set(previous.externalId, { ...previous, status: "cancelled", providerUpdatedAt: undefined,
          providerObservedAt: observedAt, revisionSource: "observed" });
      }
    }
    budget();
    return { contacts: [...contacts.values()], sessions: [...sessions.values()], cancelledIds: [...cancelled], truncated, skippedEvents,
      calendarName: clean(prop(calendar, "x-wr-calname")), timeZone: defaultZone };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("Google Calendar feed contains invalid or unsupported event data; use OAuth");
  }
}
