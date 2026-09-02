/**
 * locale-constants.ts
 *
 * Curated IANA timezone list and BCP-47 language list for account preferences.
 * Built from Intl.supportedValuesOf("timeZone") at build time to avoid a
 * runtime cost; the list covers the ~600 canonical IANA zones.
 *
 * Language list is a curated subset of BCP-47 tags covering the most common
 * human languages. Extend as product reach grows.
 */

export interface SelectOption {
  label: string;
  value: string;
}

/** Curated list of display languages (BCP-47 + display name). */
export const LANGUAGE_OPTIONS: SelectOption[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish — Español" },
  { value: "fr", label: "French — Français" },
  { value: "de", label: "German — Deutsch" },
  { value: "pt", label: "Portuguese — Português" },
  { value: "zh", label: "Chinese — 中文" },
  { value: "ja", label: "Japanese — 日本語" },
  { value: "ko", label: "Korean — 한국어" },
  { value: "ar", label: "Arabic — العربية" },
  { value: "it", label: "Italian — Italiano" },
  { value: "nl", label: "Dutch — Nederlands" },
  { value: "pl", label: "Polish — Polski" },
  { value: "ru", label: "Russian — Русский" },
  { value: "sv", label: "Swedish — Svenska" },
  { value: "tr", label: "Turkish — Türkçe" },
];

/**
 * Returns a deduplicated, sorted list of IANA timezone options using the
 * Intl API. Each option shows a human-readable label with the UTC offset.
 *
 * We call this once at module init and cache it — it's pure from the same
 * JS engine and produces a stable list within a given runtime session.
 */
function buildTimezoneOptions(): SelectOption[] {
  // Intl.supportedValuesOf is available in Node 18+ and all modern browsers.
  const zones: string[] =
    typeof Intl !== "undefined" && "supportedValuesOf" in Intl
      ? (
          Intl as unknown as { supportedValuesOf(key: string): string[] }
        ).supportedValuesOf("timeZone")
      : FALLBACK_TIMEZONES;

  const now = Date.now();

  const options: SelectOption[] = zones.map((tz) => {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "shortOffset",
      });
      const parts = formatter.formatToParts(now);
      const offset = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
      const label = `${tz.replace(/_/g, " ")} (${offset})`;
      return { value: tz, label };
    } catch {
      return { value: tz, label: tz.replace(/_/g, " ") };
    }
  });

  // Sort: UTC first, then alphabetically by zone name.
  options.sort((a, b) => {
    if (a.value === "UTC") return -1;
    if (b.value === "UTC") return 1;
    return a.value.localeCompare(b.value);
  });

  return options;
}

/**
 * Minimal fallback list for environments where Intl.supportedValuesOf is not
 * available (should not happen in Node 18+ / modern browsers).
 */
const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export const TIMEZONE_OPTIONS: SelectOption[] = buildTimezoneOptions();
