import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import "./date-picker.css";

const pad = (value: number) => String(value).padStart(2, "0");
const localDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDate = (value: string) => {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : null;
};
const months = Array.from({ length: 12 }, (_, month) =>
  new Date(2026, month, 1).toLocaleString(undefined, { month: "long" }),
);
const dateLabel = (date: Date) =>
  date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

export function DatePicker({
  name,
  label,
  withTime = false,
  defaultValue = "",
  value,
  onChange,
  disabled = false,
  defaultTime = "23:59",
  required = false,
}: {
  name: string;
  label: string;
  withTime?: boolean;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  defaultTime?: string;
  required?: boolean;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const current = value ?? internalValue;
  const selected = parseDate(current);
  const time = current.split("T")[1]?.slice(0, 5) || defaultTime;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const date = parseDate(current) ?? new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const [focusDay, setFocusDay] = useState("");
  const wrapper = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const today = new Date();
  const year = month.getFullYear(),
    monthIndex = month.getMonth();
  const startOffset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const count = new Date(year, monthIndex + 1, 0).getDate();
  const days = Array.from(
    { length: Math.ceil((startOffset + count) / 7) * 7 },
    (_, index) =>
      index < startOffset || index >= startOffset + count
        ? null
        : new Date(year, monthIndex, index - startOffset + 1),
  );
  const years = Array.from({ length: 41 }, (_, index) => year - 20 + index);
  function change(next: string) {
    if (value === undefined) setInternalValue(next);
    onChange?.(next);
  }
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function choose(date: Date) {
    change(`${localDate(date)}${withTime ? `T${time}` : ""}`);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    if (!withTime) close();
  }
  function shortcut(offset: number) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    choose(date);
  }
  function editTime(part: "hour" | "minute", next: string) {
    const [hour, minute] = time.split(":");
    const date = selected ?? today;
    change(
      `${localDate(date)}T${part === "hour" ? next : hour}:${part === "minute" ? next : minute}`,
    );
  }
  function dayKey(event: KeyboardEvent<HTMLButtonElement>, date: Date) {
    const amount = (
      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
        string,
        number
      >
    )[event.key];
    if (amount === undefined) return;
    event.preventDefault();
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    setFocusDay(localDate(next));
  }
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  useEffect(() => {
    if (open && focusDay) {
      wrapper.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${focusDay}"]`)
        ?.focus();
      setFocusDay("");
    }
  }, [open, focusDay, month]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const text = selected
    ? selected.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }) + (withTime ? ` · ${time}` : "")
    : "Choose a date";
  return (
    <div
      className="date-picker"
      ref={wrapper}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <span className="date-picker-label" id={`${id}-label`}>
        {label}
        {required ? " *" : ""}
      </span>
      <input type="hidden" name={name} value={current} />
      <button
        ref={trigger}
        type="button"
        className={`date-picker-trigger${selected ? " has-value" : ""}`}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-expanded={open}
        aria-controls={`${id}-calendar`}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          if (!open) {
            const date = selected ?? new Date();
            setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
            setFocusDay(localDate(date));
          }
          setOpen(!open);
        }}
      >
        <CalendarDays size={17} />
        <span id={`${id}-value`}>{text}</span>
      </button>
      {required && !current && (
        <input
          className="date-picker-required"
          aria-label={label}
          required
          value=""
          tabIndex={-1}
          onChange={() => {}}
          onInvalid={(event) => {
            event.preventDefault();
            setOpen(true);
            trigger.current?.focus();
          }}
        />
      )}
      {open && (
        <div
          className="date-picker-panel"
          id={`${id}-calendar`}
          role="dialog"
          aria-label={`${label} calendar`}
        >
          <div className="date-picker-shortcuts">
            <button type="button" onClick={() => shortcut(0)}>
              Today
            </button>
            <button type="button" onClick={() => shortcut(1)}>
              Tomorrow
            </button>
            <button type="button" onClick={() => shortcut(7)}>
              Next week
            </button>
          </div>
          <div className="date-picker-navigation">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <label className="sr-only" htmlFor={`${id}-month`}>
              Month
            </label>
            <select
              id={`${id}-month`}
              value={monthIndex}
              onChange={(event) =>
                setMonth(new Date(year, Number(event.target.value), 1))
              }
            >
              {months.map((name, index) => (
                <option value={index} key={name}>
                  {name}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`${id}-year`}>
              Year
            </label>
            <select
              id={`${id}-year`}
              value={year}
              onChange={(event) =>
                setMonth(new Date(Number(event.target.value), monthIndex, 1))
              }
            >
              {years.map((year) => (
                <option key={year}>{year}</option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}
            >
              <ChevronRight size={17} />
            </button>
          </div>
          <div
            className="date-picker-grid"
            aria-label={month.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          >
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
              <span className="date-picker-weekday" key={day}>
                {day}
              </span>
            ))}
            {days.map((date, index) =>
              date ? (
                <button
                  key={localDate(date)}
                  type="button"
                  data-date={localDate(date)}
                  className={`date-picker-day${localDate(date) === current.slice(0, 10) ? " selected" : ""}`}
                  aria-label={dateLabel(date)}
                  aria-pressed={localDate(date) === current.slice(0, 10)}
                  aria-current={
                    localDate(date) === localDate(today) ? "date" : undefined
                  }
                  onClick={() => choose(date)}
                  onKeyDown={(event) => dayKey(event, date)}
                >
                  {date.getDate()}
                </button>
              ) : (
                <span key={`empty-${index}`} />
              ),
            )}
          </div>
          {withTime && (
            <div className="date-picker-time">
              <span>Time</span>
              <label>
                Hour
                <select
                  aria-label={`${label} hour`}
                  value={time.split(":")[0]}
                  onChange={(event) => editTime("hour", event.target.value)}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour}>{pad(hour)}</option>
                  ))}
                </select>
              </label>
              <label>
                Minute
                <select
                  aria-label={`${label} minute`}
                  value={time.split(":")[1]}
                  onChange={(event) => editTime("minute", event.target.value)}
                >
                  {Array.from({ length: 60 }, (_, minute) => (
                    <option key={minute}>{pad(minute)}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="date-picker-actions">
            {!required && (
              <button
                type="button"
                disabled={!current}
                onClick={() => {
                  change("");
                  close();
                }}
              >
                <X size={14} />
                Clear date
              </button>
            )}
            <button className="primary" type="button" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
