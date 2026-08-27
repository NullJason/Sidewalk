/**
 * "This weekend" in New York, computed per request.
 *
 * The city is hardcoded (spec.md), and that matters here more than anywhere else:
 * events are stored as UTC instants, but a weekend is a local-calendar idea. A
 * Sunday 11pm show in Manhattan is already Monday in UTC, and a Friday 9pm show is
 * already Saturday in UTC. Doing this arithmetic on UTC dates would include the
 * Friday event and exclude the Sunday one — both wrong.
 */
const TIME_ZONE = 'America/New_York';

const DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short'
});

const OFFSET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  timeZoneName: 'longOffset'
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface WeekendWindow {
  today: string; // New York calendar date, YYYY-MM-DD
  saturday: string;
  sunday: string;
  startIso: string; // inclusive — New York midnight, Saturday
  endIso: string; // exclusive — New York midnight, Monday
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 = Sunday
}

function toLocalDate(instant: Date): LocalDate {
  const parts = new Map(DATE_PARTS.formatToParts(instant).map((part) => [part.type, part.value]));

  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    weekday: WEEKDAYS.indexOf(parts.get('weekday') ?? '')
  };
}

function formatLocalDate({ year, month, day }: LocalDate): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Day arithmetic goes through `Date.UTC`, which handles month and year rollover, so
 * nothing here has to know how long a month is. These are calendar dates being
 * shifted, not instants, so the UTC detour cannot drift.
 */
function addDays({ year, month, day }: LocalDate, days: number): string {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** YYYY-MM-DD, optionally followed by a wall-clock time. Anything else is not a date. */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?$/;

/**
 * New York's offset from UTC on `date`, as "-04:00" or "-05:00".
 *
 * Read at midday on that date rather than assumed, so EST and EDT both come out right —
 * and midday is far enough from either DST transition (they happen at 2am) to be
 * unambiguous.
 */
function offsetOn(date: string): string {
  const midday = new Date(`${date}T12:00:00Z`);
  const offset = OFFSET_PARTS.formatToParts(midday).find(
    (part) => part.type === 'timeZoneName'
  )?.value;

  // "GMT-04:00" -> "-04:00". Bare "GMT" means UTC, which longOffset reports without
  // a numeric suffix.
  return (offset ?? '').replace('GMT', '') || '+00:00';
}

/**
 * The instant a New York wall-clock time refers to, or null if that is not a date.
 *
 * `new Date("2026-08-29T21:00:00")` reads an offset-less time in *the machine's* zone —
 * which is New York on a laptop in Brooklyn and UTC on the deploy box, four hours apart.
 * Anything reading a time that did not come with an offset has to say which zone it
 * meant, and around here the answer is always New York.
 */
export function newYorkInstant(local: string): Date | null {
  const match = LOCAL_DATE_TIME.exec(local.trim());
  if (!match) return null;

  const [, date, time = '00:00:00'] = match;
  const parsed = new Date(`${date}T${time}${offsetOn(date as string)}`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The UTC instant of New York midnight on `date`. */
function midnightIso(date: string): string {
  return `${new Date(`${date}T00:00:00${offsetOn(date)}`).toISOString().slice(0, 19)}Z`;
}

/**
 * Saturday and Sunday of the weekend `now` belongs to: the one already under way if
 * it is the weekend, otherwise the one coming up.
 */
export function weekendWindow(now: Date): WeekendWindow {
  const today = toLocalDate(now);

  // Saturday = 6. On Sunday the weekend started yesterday; on any other day it is
  // still ahead. Both fall out of the same expression once Sunday is offset by -1.
  const daysToSaturday = today.weekday === 0 ? -1 : 6 - today.weekday;

  const saturday = addDays(today, daysToSaturday);
  const sunday = addDays(today, daysToSaturday + 1);
  const monday = addDays(today, daysToSaturday + 2);

  return {
    today: formatLocalDate(today),
    saturday,
    sunday,
    startIso: midnightIso(saturday),
    endIso: midnightIso(monday)
  };
}

/**
 * The New York calendar date an instant falls on, YYYY-MM-DD.
 *
 * The same instant is a different date in UTC for four or five hours every evening,
 * which is exactly the window most events run in — so anything that files an event
 * under a day has to ask here rather than slicing the ISO string.
 */
export function newYorkDate(instant: Date): string {
  return formatLocalDate(toLocalDate(instant));
}

/**
 * `time` is an ISO 8601 interval, "start/end". Every filter takes the start — the
 * spec calls this the most likely source of a silent bug in this ticket, so it lives
 * in one place that everything else calls.
 */
export function eventStart(interval: string): Date | null {
  const start = interval.split('/')[0]?.trim();
  if (!start) return null;

  const parsed = new Date(start);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Half-open: an event starting exactly at New York midnight on Saturday is in, one
 * starting exactly at New York midnight on Monday is out. An unparseable time is
 * out rather than an exception — a single malformed row must not fail a request.
 */
export function isInWindow(interval: string, window: WeekendWindow): boolean {
  const start = eventStart(interval);
  if (!start) return false;

  return (
    start.getTime() >= Date.parse(window.startIso) && start.getTime() < Date.parse(window.endIso)
  );
}
