// The person's zone, written so the browser keeps it between visits.
//
// It is written by <TimeZoneProvider> on the client and by the Account dialog's
// server action, and read by neither: next-intl's request config cannot read a
// cookie without making every route in the app unprerenderable, so the zone
// reaches next-intl through the client provider that `[org]/layout.tsx` mounts
// inside its own <Suspense> (see src/i18n/request.ts for why).
//
// `isTimeZone` guards what is stored, because a stored preference can name a
// zone this runtime's ICU has never heard of.

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
