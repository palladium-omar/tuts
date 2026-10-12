import test from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_CALENDAR_SCOPES,
  pullGoogleCalendar,
  type GoogleCalendarCredentials,
} from "../src/google-calendar-provider.js";
import type { ExternalSession } from "../src/schemas.js";

const calendarId = "synthetic-calendar@example.invalid";
const credentials: GoogleCalendarCredentials = {
  accessToken: "synthetic-access-token",
  refreshToken: "synthetic-refresh-token",
  expiresAt: Date.now() + 60_000,
  scope: GOOGLE_CALENDAR_SCOPES.join(" "),
};
const event = (id: string, htmlLink: string) => ({
  id,
  summary: "Synthetic tutoring appointment",
  start: { dateTime: "2030-01-02T10:00:00Z" },
  end: { dateTime: "2030-01-02T11:00:00Z" },
  updated: "2030-01-01T09:00:00Z",
  htmlLink,
});

async function pullEvents(items: unknown[], prior: ExternalSession[] = []) {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    return Response.json({ items });
  };
  try {
    const result = await pullGoogleCalendar(credentials, { calendarId }, prior);
    assert.equal(calls, 1, "the mock must satisfy the pull without any other network request");
    return result;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("Google event links preserve the real www event format and Calendar-hosted links", async () => {
  const links = [
    "https://www.google.com/calendar/event?eid=synthetic-event",
    "https://calendar.google.com/calendar/event?eid=synthetic-event",
    "https://calendar.google.com/calendar/u/0/r/eventedit/synthetic-event",
  ];
  const result = await pullEvents(links.map((link, index) => event(`valid-${index}`, link)));
  assert.equal(result.truncated, false);
  assert.deepEqual(result.sessions.map(session => session.bookingUrl), links);
  assert.ok(result.sessions.every(session => session.status === "scheduled"));
});

test("unsafe Google-looking links are omitted without dropping their appointments", async () => {
  const links = [
    "https://www.google.com.evil.invalid/calendar/event?eid=synthetic",
    "https://calendar.google.com.evil.invalid/calendar/event?eid=synthetic",
    "https://synthetic:password@www.google.com/calendar/event?eid=synthetic",
    "https://synthetic:password@calendar.google.com/calendar/event?eid=synthetic",
    "https://www.google.com:8443/calendar/event?eid=synthetic",
    "https://calendar.google.com:8443/calendar/event?eid=synthetic",
    "http://www.google.com/calendar/event?eid=synthetic",
    "https://www.google.com/url?q=https%3A%2F%2Fevil.invalid",
    "https://www.google.com/calendar/event/redirect?url=https%3A%2F%2Fevil.invalid",
  ];
  const result = await pullEvents(links.map((link, index) => event(`unsafe-${index}`, link)));
  assert.equal(result.sessions.length, links.length);
  assert.ok(result.sessions.every(session => session.bookingUrl === undefined));
  assert.equal(result.truncated, false);
});

test("sparse cancellation keeps prior event times and its usable Google event link", async () => {
  const link = "https://www.google.com/calendar/event?eid=synthetic-event";
  const first = await pullEvents([event("cancelled-event", link)]);
  const prior = first.sessions[0]!;
  const result = await pullEvents([{ id: "cancelled-event", status: "cancelled" }], [prior]);
  const cancelled = result.sessions[0]!;
  assert.equal(result.sessions.length, 1);
  assert.equal(cancelled.externalId, prior.externalId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.startsAt, prior.startsAt);
  assert.equal(cancelled.endsAt, prior.endsAt);
  assert.equal(cancelled.bookingUrl, link);
  assert.equal(cancelled.providerUpdatedAt, undefined, "missing Google update timestamps must not be fabricated");
  assert.equal(cancelled.revisionSource, "observed");
  assert.ok(Number.isFinite(Date.parse(cancelled.providerObservedAt!)));
  assert.deepEqual(result.cancelledIds, [prior.externalId]);
  assert.equal(result.truncated, false);
});
