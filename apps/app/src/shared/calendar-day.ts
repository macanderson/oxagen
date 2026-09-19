// A calendar day the viewer picked, as UTC instants in their IANA zone.
//
// `<input type="date">` and the audit day filters hand over a bare
// `YYYY-MM-DD`. The app prints every date in the viewer's zone, so the day
// those controls name is that zone's day, not UTC's. This module is the one
// place that turns a day-plus-zone into the inclusive start and exclusive end
// instants the contracts store and query.
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The UTC instant for `year-month-day hour:minute:second.ms` in `timeZone`.
 * Walks once from a UTC guess: format the guess in the zone, subtract the
 * local-vs-intended delta, then correct once more when DST moved the offset.
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
  const shift = (instant: number): number => {
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
    return asLocal - instant;
  };
  let utc = asUtc - shift(asUtc);
  utc = asUtc - shift(utc);
  return new Date(utc);
}

function parseDay(day: string): { year: number; month: number; day: number } | null {
  if (!DAY.test(day)) return null;
  const [year, month, dayNum] = day.split("-").map(Number);
  if (year === undefined || month === undefined || dayNum === undefined) {
    return null;
  }
  return { year, month, day: dayNum };
}

/** Midnight at the start of `day` in `timeZone`, as an ISO instant. */
export function startOfZonedDay(
  day: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  const parts = parseDay(day);
  if (parts === null) return null;
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
 * Midnight at the start of the calendar day after `day` in `timeZone`. Audit
 * `to` filters are exclusive at this instant so the named day stays inclusive.
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
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, "0");
  const d = String(next.getUTCDate()).padStart(2, "0");
  return startOfZonedDay(`${y}-${m}-${d}`, timeZone);
}
