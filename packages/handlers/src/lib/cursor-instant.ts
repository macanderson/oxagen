// The instant a keyset cursor carries, in the one shape `toISOString()` writes.
//
// A cursor decoder checks this before it lets the instant reach a query.
// `Date.parse` alone also accepts signed and expanded years
// ("-000001-01-01T00:00:00.000Z") and year 0000, and Postgres refuses all of
// them as `timestamptz` (it has no year zero). A crafted cursor would reach
// the database and come back as a 500 rather than as the caller's
// `invalid_cursor`.
export const CURSOR_INSTANT =
  /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether a decoded cursor's instant is one this server wrote. */
export function isCursorInstant(value: string): boolean {
  return CURSOR_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}
