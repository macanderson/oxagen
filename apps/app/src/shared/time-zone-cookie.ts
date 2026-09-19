// The person's zone, as a cookie the request config can read.
//
// Server Components format through next-intl's request config, not through the
// client <TimeZoneProvider>. Cache Components keeps person-specific DB reads
// out of that config (the static shell prerenders without them), so the zone
// rides a cookie instead: small, available on the request, and kept in sync
// when the preference is read into the provider or written by the Account
// dialog. A missing or unknown value falls back to DEFAULT_TIME_ZONE.
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";

/** Cookie name. Kept short; only this module should spell it. */
export const TIME_ZONE_COOKIE = "tz";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * True when `Intl` can format in `name` on this runtime. A cookie is free text
 * from the browser, and a stored preference can name a zone this runtime's ICU
 * has never heard of, so a garbage value must not reach `DateTimeFormat`.
 */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a raw cookie value to a zone this runtime can format in. */
export function resolveTimeZoneCookie(
  value: string | null | undefined,
): string {
  if (value && isTimeZone(value)) return value;
  return DEFAULT_TIME_ZONE;
}

/** Read the zone from a `Cookie` header string (client or tests). */
export function readTimeZoneCookie(cookie: string): string {
  const match = /(?:^|;\s*)tz=([^;]*)/.exec(cookie);
  const raw = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  return resolveTimeZoneCookie(raw);
}

/** `document.cookie` / Set-Cookie value for the zone. */
export function timeZoneCookieString(
  timeZone: string,
  secure: boolean,
): string {
  return `${TIME_ZONE_COOKIE}=${encodeURIComponent(timeZone)}; Path=/; Max-Age=${String(ONE_YEAR_SECONDS)}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Options for `cookies().set` in a Server Action. */
export function timeZoneCookieOptions(secure: boolean): {
  path: string;
  maxAge: number;
  sameSite: "lax";
  secure: boolean;
} {
  return {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
    secure,
  };
}
