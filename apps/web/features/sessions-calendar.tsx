import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Plug,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { type Api, errorMessage } from "../lib/api";
import { Modal, Notice } from "../components/shared";
import "./sessions-calendar.css";

type Session = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "completed" | "cancelled";
  provider: "calendly" | "calcom";
  attendeeName?: string | null;
  attendeeEmail?: string | null;
  bookingUrl?: string | null;
};
type Booking = Session & { start: Date; end: Date };
type View = "month" | "week";
const providers = { calendly: "Calendly", calcom: "Cal.com" };
const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);
const startOfWeek = (date: Date) => addDays(date, -((date.getDay() + 6) % 7));
const time = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fullDate = (date: Date) =>
  date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
const minutes = (date: Date) => date.getHours() * 60 + date.getMinutes();
const overlapsDay = (booking: Booking, day: Date) =>
  booking.start < addDays(day, 1) && booking.end > day;
const timeRange = (booking: Booking) =>
  sameDay(booking.start, booking.end)
    ? `${time(booking.start)} – ${time(booking.end)}`
    : `${booking.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(booking.start)} – ${booking.end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(booking.end)}`;
function bookingLink(url?: string | null) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

// Each overlapping group shares columns. Cross-midnight bookings are clipped to
// local calendar days; date arithmetic, rather than 24-hour addition, handles DST.
function weekPositions(bookings: Booking[], day: Date) {
  const segments = bookings
    .filter((booking) => overlapsDay(booking, day))
    .map((booking) => {
      const start = booking.start <= day ? 0 : minutes(booking.start);
      const end = booking.end >= addDays(day, 1) ? 1440 : minutes(booking.end);
      const displayStart = Math.min(start, 1414);
      return {
        booking,
        start: displayStart,
        end: Math.min(1440, Math.max(end, displayStart + 26)),
        column: 0,
        columns: 1,
      };
    })
    .sort(
      (a, b) =>
        a.start - b.start ||
        b.end - a.end ||
        a.booking.id.localeCompare(b.booking.id),
    );
  let group: typeof segments = [],
    laneEnds: number[] = [],
    groupEnd = -1;
  function finishGroup() {
    for (const segment of group) segment.columns = laneEnds.length;
    group = [];
    laneEnds = [];
    groupEnd = -1;
  }
  for (const segment of segments) {
    if (segment.start >= groupEnd) finishGroup();
    let column = laneEnds.findIndex((end) => end <= segment.start);
    if (column === -1) column = laneEnds.length;
    laneEnds[column] = segment.end;
    segment.column = column;
    group.push(segment);
    groupEnd = Math.max(groupEnd, segment.end);
  }
  finishGroup();
  return segments;
}

export function Sessions({
  api,
  onConnect,
}: {
  api: Api;
  onConnect: () => void;
}) {
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));
  const [rows, setRows] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Booking | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const weekScroll = useRef<HTMLDivElement>(null);
  const agenda = useRef<HTMLElement>(null);
  const today = startOfDay(new Date());
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rangeStart =
    view === "month"
      ? startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
      : startOfWeek(anchor);
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const dayCount =
    view === "month"
      ? Math.ceil(
          (new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate() +
            ((monthStart.getDay() + 6) % 7)) /
            7,
        ) * 7
      : 7;
  const from = rangeStart.toISOString();
  const to = addDays(rangeStart, dayCount).toISOString();
  const days = Array.from({ length: dayCount }, (_, index) =>
    addDays(rangeStart, index),
  );
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setRows([]);
    setTotal(0);
    (async () => {
      try {
        const all: Session[] = [];
        let available = 0;
        do {
          const query = new URLSearchParams({
            from,
            to,
            limit: "200",
            offset: String(all.length),
          });
          const result = await api(`scheduling/v1/external-sessions?${query}`);
          if (!current) return;
          available = result.total;
          all.push(...result.items);
          if (!result.items.length) break;
        } while (all.length < available && all.length < 5000);
        if (current) {
          setRows(all);
          setTotal(available);
        }
      } catch (cause) {
        if (current) setError(errorMessage(cause));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [api, from, to, revision]);
  const bookings = useMemo(
    () =>
      rows
        .map((row) => ({
          ...row,
          start: new Date(row.startsAt),
          end: new Date(row.endsAt),
        }))
        .filter(
          (booking) =>
            Number.isFinite(booking.start.getTime()) &&
            Number.isFinite(booking.end.getTime()) &&
            (showCancelled || booking.status !== "cancelled"),
        )
        .sort(
          (a, b) =>
            a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id),
        ),
    [rows, showCancelled],
  );
  useEffect(() => {
    if (view !== "week" || loading || !weekScroll.current) return;
    const firstHour = bookings.length
      ? Math.max(
          0,
          Math.min(
            18,
            Math.floor(
              Math.min(
                ...bookings.map((booking) =>
                  booking.start < new Date(from) ? 0 : minutes(booking.start),
                ),
              ) / 60,
            ) - 1,
          ),
        )
      : 7;
    weekScroll.current.scrollTop = firstHour * 56;
  }, [view, from, loading, bookings]);
  const dayBookings = bookings.filter((booking) =>
    overlapsDay(booking, selectedDay),
  );
  const label =
    view === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric", ...(days[0].getFullYear() !== days[6].getFullYear() ? { year: "numeric" as const } : {}) })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  function navigate(direction: number) {
    const next =
      view === "month"
        ? new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1)
        : addDays(anchor, direction * 7);
    setAnchor(next);
    setSelectedDay(next);
  }
  function chooseDay(day: Date, reveal = false) {
    setSelectedDay(day);
    if (reveal)
      requestAnimationFrame(() => {
        agenda.current?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
        agenda.current?.focus({ preventScroll: true });
      });
  }
  function eventLabel(booking: Booking) {
    return `${booking.title}, ${timeRange(booking)}, ${booking.attendeeName || booking.attendeeEmail || "Booked session"}, ${booking.status}`;
  }
  return (
    <div className="sessions-calendar">
      <div className="section-heading">
        <div>
          <h1>Your session calendar.</h1>
          <p className="muted">
            Your Calendly and Cal.com bookings, together. Open a session for its
            details.
          </p>
        </div>
        <div className="heading-actions">
          <button
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={16} />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="primary" onClick={onConnect}>
            <Plug size={16} />
            Calendar connections
          </button>
        </div>
      </div>
      <Notice error={error} />
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <button aria-label={`Previous ${view}`} onClick={() => navigate(-1)}>
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={() => {
              setAnchor(today);
              setSelectedDay(today);
            }}
          >
            Today
          </button>
          <button aria-label={`Next ${view}`} onClick={() => navigate(1)}>
            <ChevronRight size={18} />
          </button>
        </div>
        <h2 aria-live="polite">{label}</h2>
        <div
          className="calendar-switch"
          role="group"
          aria-label="Calendar view"
        >
          <button
            aria-pressed={view === "month"}
            onClick={() => {
              setView("month");
              setAnchor(selectedDay);
            }}
          >
            Month
          </button>
          <button
            aria-pressed={view === "week"}
            onClick={() => {
              setView("week");
              setAnchor(selectedDay);
            }}
          >
            Week
          </button>
        </div>
      </div>
      <div className="calendar-meta">
        <span className="calendar-legend">
          <span>
            <i className="calendar-dot calendly" />
            Calendly
          </span>
          <span>
            <i className="calendar-dot calcom" />
            Cal.com
          </span>
        </span>
        <small>
          <Clock3 size={13} /> Your time · {timezone}
        </small>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(event) => setShowCancelled(event.target.checked)}
          />
          Show cancelled
        </label>
      </div>
      <div className="calendar-state" role="status">
        {loading
          ? "Loading calendar…"
          : error
            ? "Calendar could not be loaded. Use Refresh to try again."
            : `${bookings.length} session${bookings.length === 1 ? "" : "s"} on this calendar${showCancelled ? " · including cancelled" : " · cancelled hidden"}`}
        {total > rows.length && !loading && (
          <strong>
            {" "}
            Showing the first {rows.length.toLocaleString()} of{" "}
            {total.toLocaleString()} bookings. Switch to Week for a smaller
            range.
          </strong>
        )}
      </div>
      <section
        className="calendar-surface"
        aria-label={`${view === "month" ? "Month" : "Week"} calendar, ${label}`}
        aria-busy={loading}
      >
        {view === "month" ? (
          <>
            <div className="calendar-weekdays" aria-hidden="true">
              {days.slice(0, 7).map((day) => (
                <span key={dayKey(day)}>
                  {day.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
              ))}
            </div>
            <div className="calendar-month">
              {days.map((day) => {
                const items = bookings.filter((booking) =>
                  overlapsDay(booking, day),
                );
                return (
                  <div
                    key={dayKey(day)}
                    className={`calendar-day${day.getMonth() !== anchor.getMonth() ? " outside-month" : ""}${sameDay(day, selectedDay) ? " selected-day" : ""}${sameDay(day, today) ? " today" : ""}`}
                  >
                    <button
                      className="calendar-day-button"
                      aria-label={`${fullDate(day)}, ${items.length} sessions${sameDay(day, today) ? ", today" : ""}`}
                      aria-pressed={sameDay(day, selectedDay)}
                      onClick={() => chooseDay(day)}
                    >
                      <time
                        dateTime={`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`}
                        aria-current={sameDay(day, today) ? "date" : undefined}
                      >
                        {day.getDate()}
                      </time>
                    </button>
                    <div className="calendar-month-events">
                      {items.slice(0, 3).map((booking) => (
                        <button
                          key={booking.id}
                          className={`calendar-event ${booking.provider} ${booking.status}`}
                          title={eventLabel(booking)}
                          aria-label={eventLabel(booking)}
                          aria-haspopup="dialog"
                          onClick={() => setSelected(booking)}
                        >
                          <time>
                            {booking.start < day ? "↳" : time(booking.start)}
                          </time>
                          <strong>
                            {booking.attendeeName || booking.title}
                          </strong>
                        </button>
                      ))}
                    </div>
                    {items.length > 3 && (
                      <button
                        className="calendar-more"
                        aria-label={`Show all ${items.length} sessions on ${fullDate(day)}`}
                        onClick={() => chooseDay(day, true)}
                      >
                        +{items.length - 3} more
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div ref={weekScroll} className="calendar-week-scroll">
            <div className="calendar-week-canvas">
              <div className="calendar-week-header">
                <span />
                {days.map((day) => (
                  <button
                    key={dayKey(day)}
                    className={`${sameDay(day, selectedDay) ? "selected-day" : ""} ${sameDay(day, today) ? "today" : ""}`}
                    aria-label={`Show sessions for ${fullDate(day)}`}
                    aria-pressed={sameDay(day, selectedDay)}
                    onClick={() => chooseDay(day)}
                  >
                    <span>
                      {day.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <strong>{day.getDate()}</strong>
                  </button>
                ))}
              </div>
              <div className="calendar-week-body">
                <div className="calendar-hours" aria-hidden="true">
                  {Array.from({ length: 24 }, (_, hour) => (
                    <span
                      className="calendar-hour"
                      key={hour}
                      style={{ top: hour * 56 }}
                    >
                      {new Date(2000, 0, 1, hour).toLocaleTimeString(
                        undefined,
                        { hour: "numeric" },
                      )}
                    </span>
                  ))}
                </div>
                {days.map((day) => (
                  <div
                    key={dayKey(day)}
                    className={`calendar-week-day${sameDay(day, today) ? " today" : ""}`}
                    aria-label={fullDate(day)}
                  >
                    {weekPositions(bookings, day).map(
                      ({ booking, start, end, column, columns }) => (
                        <button
                          key={booking.id}
                          className={`calendar-event calendar-week-event ${booking.provider} ${booking.status}`}
                          aria-label={eventLabel(booking)}
                          title={eventLabel(booking)}
                          aria-haspopup="dialog"
                          onClick={() => setSelected(booking)}
                          style={
                            {
                              top: (start / 60) * 56,
                              height: ((end - start) / 60) * 56,
                              left: `calc(${(column / columns) * 100}% + 2px)`,
                              width: `calc(${100 / columns}% - 4px)`,
                            } as CSSProperties
                          }
                        >
                          <time>{timeRange(booking)}</time>
                          <strong>
                            {booking.attendeeName || booking.title}
                          </strong>
                        </button>
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
      <section
        className="calendar-day-agenda panel"
        ref={agenda}
        tabIndex={-1}
        aria-label={`Sessions for ${fullDate(selectedDay)}`}
      >
        <div className="panel-title">
          <h3>
            {sameDay(selectedDay, today)
              ? "Today"
              : selectedDay.toLocaleDateString(undefined, { weekday: "long" })}
            <span className="muted">
              {" "}
              ·{" "}
              {selectedDay.toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
              })}
            </span>
          </h3>
          <span className="tag">
            {loading ? "Loading…" : `${dayBookings.length} sessions`}
          </span>
        </div>
        {loading ? (
          <p className="muted">Loading this day’s sessions…</p>
        ) : error ? (
          <p className="muted">Refresh the calendar to load this day.</p>
        ) : dayBookings.length ? (
          <div className="calendar-agenda-list">
            {dayBookings.map((booking) => (
              <button
                className={`calendar-agenda-item ${booking.status}`}
                key={booking.id}
                onClick={() => setSelected(booking)}
                aria-haspopup="dialog"
              >
                <span className="calendar-agenda-time">
                  {booking.start < selectedDay
                    ? "Continues"
                    : time(booking.start)}
                  <small>
                    to{" "}
                    {booking.end >= addDays(selectedDay, 1)
                      ? "midnight"
                      : time(booking.end)}
                  </small>
                </span>
                <span className="calendar-agenda-main">
                  <strong>{booking.title}</strong>
                  <span>
                    <i className={`calendar-dot ${booking.provider}`} />
                    {booking.attendeeName ||
                      booking.attendeeEmail ||
                      "Booked session"}{" "}
                    · {providers[booking.provider]}
                  </span>
                </span>
                <span className={`status ${booking.status}`}>
                  {booking.status}
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">
            No {showCancelled ? "" : "active "}sessions on this day. Bookings
            appear here after your calendar syncs.
          </p>
        )}
      </section>
      {!loading && !error && !rows.length && (
        <div className="onboarding-banner">
          <CalendarDays size={24} />
          <div>
            <strong>No synced bookings in this period.</strong>
            <p>
              Try another week or month, or check your Calendly and Cal.com
              connections. New bookings appear after the next sync.
            </p>
          </div>
          <button onClick={onConnect}>
            Calendar connections
            <ArrowUpRight size={15} />
          </button>
        </div>
      )}
      {selected && (
        <Modal title={selected.title} onClose={() => setSelected(null)}>
          <div className="calendar-detail-status">
            <span className={`status ${selected.status}`}>
              {selected.status}
            </span>
            <span className="tag">{providers[selected.provider]}</span>
          </div>
          <dl className="calendar-details">
            <div>
              <dt>
                <CalendarDays size={16} />
                Date
              </dt>
              <dd>
                {fullDate(selected.start)}
                {!sameDay(selected.start, selected.end) &&
                  ` – ${fullDate(selected.end)}`}
              </dd>
            </div>
            <div>
              <dt>
                <Clock3 size={16} />
                Time
              </dt>
              <dd>
                {timeRange(selected)}
                <small>
                  {timezone} ·{" "}
                  {Math.round(
                    (selected.end.getTime() - selected.start.getTime()) / 60000,
                  )}{" "}
                  minutes
                </small>
              </dd>
            </div>
            <div>
              <dt>
                <UserRound size={16} />
                Attendee
              </dt>
              <dd>
                {selected.attendeeName ||
                  selected.attendeeEmail ||
                  "No attendee details supplied"}
                {selected.attendeeName && selected.attendeeEmail && (
                  <small>{selected.attendeeEmail}</small>
                )}
              </dd>
            </div>
          </dl>
          <p className="calendar-detail-note">
            This booking is synced from {providers[selected.provider]}. Make
            changes in your booking tool; Tuts will pick them up during the next
            sync.
          </p>
          <div className="form-actions">
            <button onClick={() => setSelected(null)}>Close details</button>
            {bookingLink(selected.bookingUrl) && (
              <a
                className="button primary"
                href={bookingLink(selected.bookingUrl)}
                target="_blank"
                rel="noreferrer"
              >
                Open {providers[selected.provider]}
                <ArrowUpRight size={15} />
              </a>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
