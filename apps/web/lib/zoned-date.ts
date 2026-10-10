/** Date-picker wall time and service instants are deliberately separate. */
export function zonedDateInput(instant: string | null, timeZone: string): string {
  if (!instant) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, calendar: 'iso8601', numberingSystem: 'latn', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
  const value = (name: string) => parts.find(part => part.type === name)?.value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}
export function zonedDateInstant(wallTime: string, timeZone: string): string | null {
  if (!wallTime) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wallTime)) throw new Error('Choose a date and time.');
  const guessed = Date.parse(`${wallTime}:00Z`);
  if (!Number.isFinite(guessed) || zonedDateInput(new Date(guessed).toISOString(), 'UTC') !== wallTime) throw new Error('Choose a valid date and time.');
  const matches = new Set<string>();
  // Sample both sides of a clock change, including half-hour DST offsets.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = guessed + hours * 3600_000;
    const offset = Date.parse(`${zonedDateInput(new Date(sample).toISOString(), timeZone)}:00Z`) - sample;
    const candidate = new Date(guessed - offset).toISOString();
    if (zonedDateInput(candidate, timeZone) === wallTime) matches.add(candidate);
  }
  if (matches.size !== 1) throw new Error('This time falls during a clock change. Choose another time.');
  return [...matches][0];
}
