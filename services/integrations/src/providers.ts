import {
  contactSchema,
  type Contact,
  type Config,
  type ExternalSession,
  type Provider,
} from "./schemas.js";
import { ConnectorError, safeJsonGet } from "./security.js";
const text = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim()
    ? v.trim().slice(0, max)
    : typeof v === "number"
      ? String(v)
      : undefined;
const email = (v: unknown) => {
  const value = text(v, 254);
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : undefined;
};
const httpsLink = (v: unknown) => {
  const value = text(v, 2048);
  if (!value) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
};
export function field(record: unknown, path: string): unknown {
  let current: any = record;
  for (const part of path.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    current = current[part];
  }
  return current;
}
export function mappedContacts(
  body: unknown,
  config: Config,
  webhook = false,
): { contacts: Contact[]; truncated: boolean } {
  const selected = config.recordsPath
    ? field(body, config.recordsPath)
    : webhook && !Array.isArray(body) && Array.isArray(field(body, "contacts"))
      ? field(body, "contacts")
      : body;
  const records =
    webhook &&
    selected &&
    typeof selected === "object" &&
    !Array.isArray(selected)
      ? [selected]
      : selected;
  if (!Array.isArray(records))
    throw new ConnectorError(
      "Contact source must contain a JSON array; configure recordsPath if nested",
    );
  const contacts: Contact[] = [];
  for (const record of records.slice(0, 2000)) {
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new ConnectorError("Contact source contains an invalid record");
    const mapped: Record<string, unknown> = {};
    for (const [name, max] of Object.entries({
      externalId: 320,
      firstName: 80,
      lastName: 80,
      displayName: 160,
      email: 254,
      phone: 40,
      notes: 4000,
      status: 30,
      tags: 50,
    })) {
      const value = field(
        record,
        config.mapping?.[name as keyof NonNullable<Config["mapping"]>] ?? name,
      );
      if (name === "tags") {
        const values = typeof value === "string" ? value.split(/[,;|]/) : value;
        if (values !== undefined && values !== null && !Array.isArray(values))
          throw new ConnectorError(
            "Contact tags must be an array or delimited string",
          );
        if (Array.isArray(values)) {
          if (values.some((v) => typeof v !== "string"))
            throw new ConnectorError("Contact tags must contain strings");
          mapped.tags = [
            ...new Set(values.map((v) => text(v, 50)).filter(Boolean)),
          ].slice(0, 20);
        }
      } else {
        const s = text(
          value,
          name === "externalId" ? Number.MAX_SAFE_INTEGER : max,
        );
        if (s) mapped[name] = s;
      }
    }
    mapped.externalId ??= mapped.email;
    const parsed = contactSchema.safeParse(mapped);
    if (!parsed.success)
      throw new ConnectorError(
        "Contact source records require an externalId or email and valid contact fields",
      );
    contacts.push(parsed.data);
  }
  return { contacts, truncated: records.length > 2000 };
}
const auth = (token?: string): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};
export async function validateAccount(
  provider: Provider,
  token: string | undefined,
  config: Config,
): Promise<Record<string, unknown>> {
  if (provider === "calendly") {
    const body = await safeJsonGet(
      "https://api.calendly.com/users/me",
      auth(token),
    );
    const uri = text(body.resource?.uri, 512);
    if (
      !uri ||
      !/^https:\/\/api\.calendly\.com\/users\/[A-Za-z0-9-]+$/.test(uri)
    )
      throw new ConnectorError("Calendly account response was invalid");
    return {
      externalId: uri,
      name: text(body.resource.name),
      email: email(body.resource.email),
      bookingUrl: httpsLink(body.resource.scheduling_url),
    };
  }
  if (provider === "calcom") {
    const body = await safeJsonGet("https://api.cal.com/v2/me", auth(token));
    if (body.status !== "success" || !body.data?.id)
      throw new ConnectorError("Cal.com account response was invalid");
    return {
      externalId: String(body.data.id),
      name: text(body.data.name),
      email: email(body.data.email),
      bookingUrl: body.data.username
        ? `https://cal.com/${encodeURIComponent(body.data.username)}`
        : undefined,
    };
  }
  if (provider === "json_api") {
    mappedContacts(await safeJsonGet(config.url!, auth(token)), config);
    return { endpointValidated: true };
  }
  return { webhookReady: true };
}
export type SyncData = {
  contacts: Contact[];
  sessions: ExternalSession[];
  truncated: boolean;
};
function deduplicate(result: SyncData) {
  result.contacts = [
    ...new Map(result.contacts.map((c) => [c.externalId, c])).values(),
  ];
  result.sessions = [
    ...new Map(result.sessions.map((s) => [s.externalId, s])).values(),
  ];
  return result;
}
function session(input: {
  externalId: unknown;
  title: unknown;
  start: unknown;
  end: unknown;
  status: unknown;
  attendeeName?: unknown;
  attendeeEmail?: unknown;
  bookingUrl?: unknown;
  providerUpdatedAt?: unknown;
  observedAt?: string;
}): ExternalSession {
  const id = text(input.externalId, 512),
    start = text(input.start),
    end = text(input.end);
  if (
    !id ||
    !start ||
    !end ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(end) <= Date.parse(start)
  )
    throw new ConnectorError("Provider returned an invalid session");
  return {
    externalId: id,
    title: text(input.title) ?? "Tutoring session",
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    status:
      ['canceled', 'cancelled', 'rejected'].includes(String(input.status).toLowerCase())
        ? "cancelled"
        : input.status === 'no_show' ? 'no_show' : "scheduled",
    attendeeName: text(input.attendeeName),
    attendeeEmail: email(input.attendeeEmail),
    bookingUrl: httpsLink(input.bookingUrl),
    providerUpdatedAt: typeof input.providerUpdatedAt === 'string' && Number.isFinite(Date.parse(input.providerUpdatedAt))
      ? new Date(input.providerUpdatedAt).toISOString() : input.observedAt,
    revisionSource: typeof input.providerUpdatedAt === 'string' && Number.isFinite(Date.parse(input.providerUpdatedAt)) ? 'provider' : 'observed',
  };
}
function providerContact(
  externalId: unknown,
  name: unknown,
  emailValue: unknown,
  phone?: unknown,
  first?: unknown,
  last?: unknown,
): Contact {
  const phoneValue = text(phone, 40);
  const result = contactSchema.safeParse({
    externalId: text(externalId, 320),
    displayName: text(name, 160),
    email: email(emailValue),
    phone: phoneValue && phoneValue.length >= 3 ? phoneValue : undefined,
    firstName: text(first, 80),
    lastName: text(last, 80),
  });
  if (!result.success)
    throw new ConnectorError("Provider returned invalid contact data");
  return result.data;
}
export async function pull(
  provider: Provider,
  token: string | undefined,
  config: Config,
  account: Record<string, unknown>,
): Promise<SyncData> {
  if (provider === "json_api") {
    return {
      ...mappedContacts(await safeJsonGet(config.url!, auth(token)), config),
      sessions: [],
    };
  }
  if (provider === "form_webhook")
    throw new ConnectorError(
      "Form connections receive contacts through their webhook",
    );
  const result: SyncData = { contacts: [], sessions: [], truncated: false };
  const observedAt = new Date().toISOString();
  let requests = 0;
  const deadline = Date.now() + 120000;
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const get = async (url: URL, headers = auth(token)) => {
    if (++requests > 100 || Date.now() > deadline)
      throw new ConnectorError(
        "Provider synchronization exceeded its request budget",
      );
    return safeJsonGet(url.toString(), headers);
  };
  if (provider === "calendly") {
    let next: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://api.calendly.com/scheduled_events");
      url.searchParams.set("user", String(account.externalId));
      url.searchParams.set("min_start_time", cutoff);
      url.searchParams.set("count", "100");
      url.searchParams.set("sort", "start_time:desc");
      if (next) url.searchParams.set("page_token", next);
      const body = await get(url);
      if (!Array.isArray(body.collection))
        throw new ConnectorError("Calendly events response was invalid");
      for (const event of body.collection) {
        if (requests >= 90) {
          result.truncated = true;
          return deduplicate(result);
        }
        const uri = text(event.uri, 512);
        if (
          !uri ||
          !/^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9-]+$/.test(
            uri,
          )
        )
          throw new ConnectorError("Calendly event identifier was invalid");
        let inviteeToken: string | undefined;
        let first: any;
        for (let ip = 0; ip < 10; ip++) {
          if (requests >= 90) {
            result.truncated = true;
            break;
          }
          const iu = new URL(`${uri}/invitees`);
          iu.searchParams.set("count", "100");
          if (inviteeToken) iu.searchParams.set("page_token", inviteeToken);
          const invitees = await get(iu);
          if (!Array.isArray(invitees.collection))
            throw new ConnectorError("Calendly invitees response was invalid");
          for (const invitee of invitees.collection) {
            first ??= invitee;
            if (result.contacts.length >= 2000) {
              result.truncated = true;
              break;
            }
            result.contacts.push(
              providerContact(
                invitee.uri,
                invitee.name,
                invitee.email,
                invitee.text_reminder_number,
                invitee.first_name,
                invitee.last_name,
              ),
            );
          }
          inviteeToken = text(invitees.pagination?.next_page_token, 4096);
          if (!inviteeToken) break;
          if (ip === 9) result.truncated = true;
        }
        result.sessions.push(
          session({
            externalId: uri,
            title: event.name,
            start: event.start_time,
            end: event.end_time,
            status: event.status,
            attendeeName: first?.name,
            attendeeEmail: first?.email,
            bookingUrl: config.bookingUrl ?? account.bookingUrl,
            providerUpdatedAt: event.updated_at,
            observedAt,
          }),
        );
      }
      next = text(body.pagination?.next_page_token, 4096);
      if (!next) break;
      if (page === 9) result.truncated = true;
    }
  } else {
    for (const status of [
      "upcoming",
      "recurring",
      "past",
      "cancelled",
      "unconfirmed",
    ]) {
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const url = new URL("https://api.cal.com/v2/bookings");
        url.searchParams.set("status", status);
        url.searchParams.set("limit", "100");
        url.searchParams.set("afterStart", cutoff);
        if (cursor) url.searchParams.set("cursor", cursor);
        const body = await get(url, {
          ...auth(token),
          "cal-api-version": "2026-05-01",
        });
        if (body.status !== "success" || !Array.isArray(body.data))
          throw new ConnectorError("Cal.com bookings response was invalid");
        for (const booking of body.data) {
          if (!connectedCalHost(booking, account)) continue;
          const attendees = Array.isArray(booking.attendees)
            ? booking.attendees
            : [];
          const first = attendees[0];
          if (result.sessions.length >= 2000) {
            result.truncated = true;
            return deduplicate(result);
          }
          result.sessions.push(
            session({
              externalId: booking.uid ?? booking.id,
              title: booking.title,
              start: booking.start,
              end: booking.end,
              status: ['canceled','cancelled','rejected'].includes(String(booking.status).toLowerCase())
                ? booking.status : attendees.length === 1 && first?.absent === true ? 'no_show' : booking.status,
              attendeeName: first?.name,
              attendeeEmail: first?.email,
              bookingUrl: config.bookingUrl ?? account.bookingUrl,
              providerUpdatedAt: booking.updatedAt,
              observedAt,
            }),
          );
          for (const attendee of attendees) {
            if (result.contacts.length >= 2000) {
              result.truncated = true;
              break;
            }
            result.contacts.push(
              providerContact(
                attendee.email ?? `${booking.uid}:${attendee.name}`,
                attendee.name,
                attendee.email,
                attendee.phoneNumber,
              ),
            );
          }
        }
        if (!body.pagination?.hasMore) break;
        cursor = text(body.pagination.nextCursor, 4096);
        if (!cursor)
          throw new ConnectorError("Cal.com pagination response was invalid");
        if (page === 9) result.truncated = true;
      }
    }
  }
  return deduplicate(result);
}

function connectedCalHost(booking:any,account:Record<string,unknown>):boolean {
  const accountId=String(account.externalId??'');
  if(!/^[1-9][0-9]*$/.test(accountId)||!Array.isArray(booking.hosts)||
    !booking.hosts.some((host:any)=>/^[1-9][0-9]*$/.test(String(host?.id??''))))
    throw new ConnectorError('Cal.com booking host identity is unavailable');
  return booking.hosts.some((host:any)=>String(host?.id??'')===accountId);
}

/** Re-fetch one signed hook's UID through the connected account before projection. */
export async function canonicalCalBooking(token: string, uid: string, config: Config, account: Record<string, unknown>): Promise<ExternalSession | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new ConnectorError('Cal.com booking identifier is invalid');
  const body = await safeJsonGet(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}`, {
    Authorization: `Bearer ${token}`, 'cal-api-version': '2026-02-25',
  });
  if (body.status !== 'success' || !body.data || Array.isArray(body.data)) throw new ConnectorError('Cal.com booking response was invalid');
  const booking = body.data;
  if (booking.uid !== uid || !connectedCalHost(booking, account))
    throw new ConnectorError('Cal.com booking does not belong to the connected tutor');
  if (typeof booking.updatedAt !== 'string' || !Number.isFinite(Date.parse(booking.updatedAt))) return null;
  const attendees = Array.isArray(booking.attendees) ? booking.attendees : [];
  return session({externalId: booking.uid, title: booking.title, start: booking.start, end: booking.end,
    status: ['canceled','cancelled','rejected'].includes(String(booking.status).toLowerCase())
      ? booking.status : attendees.length === 1 && attendees[0].absent === true ? 'no_show' : booking.status,
    attendeeName: attendees[0]?.name, attendeeEmail: attendees[0]?.email,
    bookingUrl: config.bookingUrl ?? account.bookingUrl, providerUpdatedAt: booking.updatedAt});
}
