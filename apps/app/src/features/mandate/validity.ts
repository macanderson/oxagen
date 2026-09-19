// The end of a mandate's validity window, and the one piece of it only the
// operator's browser knows. Both halves live here rather than one in the server
// action and one in the dialog, because they are two ends of a single decision:
// which instant the operator meant when they picked a day. Splitting them across
// files is how they drift.
//
// This module is deliberately free of "use server" and of any React import, so
// the action and the client component can both take it.

/** The widest real UTC offset either side, in minutes: UTC-12 to UTC+14. */
export const OFFSET_LIMIT = 14 * 60;

/**
 * The instant a mandate stops being honoured, given the last day it may be drawn
 * on and the operator's offset on the day after it.
 *
 * Two things are folded in here. The validity window is half-open,
 * `[validFrom, validTo)` — enforcement's `isEffective` and `findCoveringMandate`
 * both compare that way — so the end of the operator's last day IS the start of
 * the next one, and there is no final millisecond to leave out. And the day is
 * the operator's, not UTC's: this used to append `T23:59:59.999Z` to the picked
 * date, which is only the right instant for an operator already on UTC. At UTC+9
 * it granted nine hours nobody asked for, and at UTC-8 it took eight away. A
 * mandate is bounded financial authority, so the boundary has to be the one the
 * person who set it saw.
 *
 * Pure, so it can be proven at any offset without a browser and without a `TZ`
 * on the test runner — which is what made the old behaviour hard to see.
 */
export function endOfLocalDay(day: string, offsetMinutes: number): string {
  const [year, month, date] = day.split("-").map(Number);
  // Date.UTC rolls a day past the month's end over for us, so the 31st of any
  // month and the 28th of February need no special case.
  const nextDayUtc = Date.UTC(year, month - 1, date + 1);
  // getTimezoneOffset is minutes to ADD to local to reach UTC, so UTC+9 reports
  // -540 and the instant is earlier than the UTC midnight, as it should be.
  return new Date(nextDayUtc + offsetMinutes * 60_000).toISOString();
}

/** Whether an offset is one a real place could be in, to the whole minute. */
export function isUsableOffset(offsetMinutes: number): boolean {
  return (
    Number.isInteger(offsetMinutes) && Math.abs(offsetMinutes) <= OFFSET_LIMIT
  );
}

/**
 * The operator's UTC offset at the start of the day AFTER `day`, which is the
 * instant `endOfLocalDay` turns into the end of the validity window.
 *
 * It is read for that date rather than for today because the offset is not a
 * constant: a window ending the day after a DST change is an hour out if we send
 * the offset in force when the dialog happened to be open. Constructing a `Date`
 * from local components makes the browser resolve the zone for that date, which
 * is the one piece of this the server cannot do.
 *
 * Zero for a blank or unparseable day. The action ignores the offset when the
 * day is blank, and refuses the day when it is not one, so this never has to
 * guess on the caller's behalf.
 */
export function offsetAfter(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(date)
  )
    return 0;
  return new Date(year, month - 1, date + 1).getTimezoneOffset();
}
