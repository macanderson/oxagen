// A time zone name the runtime can format in. The stored column is free text
// and the contract admits any `Area/City`-shaped string, so a value that
// passed both can still be one this runtime's ICU data has never heard of.
// `Intl.DateTimeFormat` throws a RangeError on such a name, at render, inside
// every date on the page; the check runs once, where the value comes in.

/** True when `Intl` can format in `name` on this runtime. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zones a person can pick from: what this runtime supports, with `current`
 * kept in the list when it is a zone the list does not carry (an alias such as
 * `US/Pacific`, or a name a newer ICU knows), so the select never shows a
 * choice other than the one stored.
 */
export function timeZoneChoices(current: string): string[] {
  const names = Intl.supportedValuesOf("timeZone");
  return names.includes(current) ? names : [current, ...names];
}
