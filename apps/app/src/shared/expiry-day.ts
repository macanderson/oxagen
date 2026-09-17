// The day an expiry picker names, as the instant the contract stores.
//
// `<input type="date">` has no timezone: its value is a bare `YYYY-MM-DD` that
// the browser renders in the viewer's calendar conventions and hands over
// unconverted. Somebody has to say which day that is, and this codebase says
// UTC — the instant lands in a `timestamptz`, the audit record is in UTC, and
// `resolveApiKey` compares against it in UTC. The alternative, the selected
// day's *local* boundary, needs the viewer's IANA zone rather than an offset
// (a zone's offset moves under DST) and a zone-aware calendar to compute it,
// for a field whose whole job is "stop working after this day".
//
// So the rule is stated rather than inferred: the field is labelled UTC and the
// dialog prints the instant this function returns beneath it, so what the
// control means and what it stores are the same thing on screen. The action
// encodes with this function and the dialog previews with it, so they cannot
// drift.

/** A date the picker produced, as a day and nothing finer. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The last instant of `day` in UTC, or null when the field is not a day this
 * calendar has. `new Date` rolls a February 31st forward, so the round trip is
 * what rejects it.
 *
 * The end of the day, never midnight at its start: a key picked to expire today
 * would otherwise be expired before it was minted, and `resolveApiKey`
 * (`packages/auth/src/resolvers/api-key.ts:144-145`) would refuse the secret
 * shown once for it.
 */
export function endOfUtcDay(day: string): string | null {
  if (!DAY.test(day)) return null;
  const instant = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(instant.getTime())) return null;
  const iso = instant.toISOString();
  return iso.startsWith(day) ? iso : null;
}
