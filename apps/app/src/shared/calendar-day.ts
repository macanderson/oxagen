// A calendar day the viewer picked, as UTC instants in their IANA zone.
//
// `<input type="date">` and the audit day filters hand over a bare
// `YYYY-MM-DD`. The app prints every date in the viewer's zone, so the day
// those controls name is that zone's day, not UTC's. This module is the one
// place that turns a day-plus-zone into the inclusive start and exclusive end
// instants the contracts store and query.
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;

/**
 * True when this runtime's ICU data can format in `name`. The stored zone is
 * free text and the contract admits any zone-shaped string, so a value this
 * runtime has never heard of can reach here, and `Intl.DateTimeFormat` throws a
 * RangeError on it rather than answering. Every resolver below asks first, so an
 * unsupported zone reads as no answer — the same as a malformed day — instead of
 * throwing out of a date conversion. A caller that would rather draw the page in
 * the default zone than lose the bound asks too, and picks the default itself.
 */
export function supportsTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The parts of `instant` as `timeZone` reads them, as a comparable UTC number,
 * plus the zone's offset from UTC at that instant in milliseconds.
 */
function zonedPartsOf(
  instant: number,
  timeZone: string,
): { asLocal: number; offset: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? Number.NaN : Number(value);
  };
  const asLocal = Date.UTC(
    num("year"),
    num("month") - 1,
    num("day"),
    num("hour"),
    num("minute"),
    num("second"),
  );
  return { asLocal, offset: asLocal - instant };
}

/**
 * The UTC instant for `year-month-day hour:minute:second` in `timeZone`.
 *
 * A civil time is not always one instant. A DST transition can skip it — the
 * clock jumps forward over it, so it never happens — or repeat it, when the
 * clock falls back over it. Sample the zone's offset a day either side of the
 * naive guess, which brackets any transition within the day, and try both
 * offsets; a candidate counts only when formatting it back in the zone yields
 * the civil time we asked for.
 *
 * Skipped times therefore resolve forward by the length of the gap, and
 * repeated times resolve to the first of the two instants — both of which come
 * from the pre-transition offset, so that candidate is the one to prefer.
 * Asking for a skipped local midnight (America/Santiago on 2026-09-06, where
 * the clock goes 00:00 -> 01:00) gives 01:00 that same day, the first instant
 * the civil day has. Taking the other offset would land at 23:00 the day
 * before, putting an audit bound or a mandate window on the wrong date.
 */
function zonedPartsToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(zonedPartsOf(asUtc, timeZone).offset)) {
    return new Date(Number.NaN);
  }
  const before = asUtc - zonedPartsOf(asUtc - DAY_MS, timeZone).offset;
  const after = asUtc - zonedPartsOf(asUtc + DAY_MS, timeZone).offset;
  for (const candidate of [before, after]) {
    if (zonedPartsOf(candidate, timeZone).asLocal === asUtc) {
      return new Date(candidate);
    }
  }
  // Neither round-trips: the civil time falls in a gap. `before` uses the
  // offset in force ahead of the jump, which lands just after it — the first
  // instant this civil time's day actually reaches.
  return new Date(before);
}

/**
 * Whether `raw` is a calendar day that exists.
 *
 * The shape is not enough, and this is the one place that says so. `2026-99-99`
 * matches the pattern and makes an Invalid Date; `2027-02-31` is worse, because
 * `Date.UTC` rolls it forward to 3 March without complaint. For a mandate's
 * validity end that is three days of authority obtained by sending a day that
 * does not exist, so the value has to round-trip through UTC as the day it
 * claims to be before anything converts it.
 *
 * Exported because the same check is owed by every surface that takes a day from
 * a caller: the audit filters, and `changeMandateLimits`, which had only the
 * pattern.
 */
export function isCalendarDay(raw: string): boolean {
  if (!DAY.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(raw)
  );
}

function parseDay(
  day: string,
): { year: number; month: number; day: number } | null {
  if (!DAY.test(day)) return null;
  const [year, month, dayNum] = day.split("-").map(Number);
  if (year === undefined || month === undefined || dayNum === undefined) {
    return null;
  }
  return { year, month, day: dayNum };
}

/**
 * The first instant of `day` in `timeZone`, as an ISO instant. Normally that is
 * local midnight; where a DST jump skips midnight there is no such instant, so
 * this is the first one the civil day does reach.
 */
export function startOfZonedDay(
  day: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  const parts = parseDay(day);
  if (parts === null || !supportsTimeZone(timeZone)) return null;
  const instant = zonedPartsToUtc(
    parts.year,
    parts.month,
    parts.day,
    0,
    0,
    0,
    timeZone,
  );
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * The last millisecond of `day` in `timeZone`, as an ISO instant. Mandates
 * that run "through" a day use this so a single-day window is a day, not empty.
 * Defined as one millisecond before the next civil day's start, so DST days
 * stay correct without formatting 23:59:59.999 through Intl (which has no ms).
 */
export function endOfZonedDay(
  day: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  const next = startOfNextZonedDay(day, timeZone);
  if (next === null) return null;
  return new Date(Date.parse(next) - 1).toISOString();
}

/**
 * The first instant of the calendar day after `day` in `timeZone`. Audit `to`
 * filters are exclusive at this instant so the named day stays inclusive.
 */
export function startOfNextZonedDay(
  day: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  const parts = parseDay(day);
  if (parts === null) return null;
  // Step the civil Y-M-D triple, then resolve that next civil day in the zone.
  // Do not add 24h to an instant: DST days are not 24 hours long.
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const y = String(next.getUTCFullYear()).padStart(4, "0");
  const m = String(next.getUTCMonth() + 1).padStart(2, "0");
  const d = String(next.getUTCDate()).padStart(2, "0");
  return startOfZonedDay(`${y}-${m}-${d}`, timeZone);
}
