/**
 * The CGP timestamp profile (`SPEC.md` section F4), which Tacho adopts for
 * every `ts`: RFC 3339, uppercase `T`, uppercase `Z`, UTC only, optional
 * fractional seconds. One spelling per instant, so two events with the same
 * instant compare equal as strings.
 */
const PROFILE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$/;

export function isProtocolTimestamp(value: string): boolean {
  if (!PROFILE.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }
  // Date.parse rolls an impossible day (Feb 30) into the next month; the
  // profile does not, so the calendar part must round-trip unchanged.
  return new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Render a Date (or epoch milliseconds) in the profile with millisecond precision. */
export function toProtocolTimestamp(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      "cannot render an invalid date as a protocol timestamp",
    );
  }
  return date.toISOString();
}

/** OTLP carries nanoseconds since the epoch as a decimal string. */
export function fromUnixNano(nanos: string | number): string {
  const big =
    typeof nanos === "string" ? BigInt(nanos) : BigInt(Math.trunc(nanos));
  const millis = Number(big / 1_000_000n);
  return toProtocolTimestamp(millis);
}
