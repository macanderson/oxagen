// The zones a person can pick from in the Account dialog.

/**
 * What this runtime supports, with `current` kept in the list when it is a
 * zone the list does not carry (an alias such as `US/Pacific`, or a name a
 * newer ICU knows), so the select never shows a choice other than the one
 * stored. `names` defaults to the runtime's list; a test passes a short one.
 */
export function timeZoneChoices(
  current: string,
  names: readonly string[] = Intl.supportedValuesOf("timeZone"),
): string[] {
  return names.includes(current) ? [...names] : [current, ...names];
}
