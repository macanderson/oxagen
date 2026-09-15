// The one place a post-sign-in destination is decided.
//
// `?next=` arrives from the address bar, so it is attacker-controlled. It is
// accepted only as a same-origin relative path: it starts with "/", and neither
// "//" (protocol-relative, another host) nor "/\" (browsers normalise the
// backslash to a slash, which makes it "//" again). Control characters are
// refused because browsers strip tab and newline inside URLs, so "/\t/evil"
// would also become "//evil". The path is then resolved against a sentinel
// origin and the *normalised* result is checked again: "/a/../..//evil"
// resolves to "//evil", which a router would treat as another host.
//
// A destination back into the sign-in flow is refused too, so a crafted link
// cannot loop a person between log in and two-factor.

export const DEFAULT_NEXT = "/";

/** Longest `next` accepted; the CLI authorize round-trip carries a PKCE challenge and a loopback URI. */
export const MAX_NEXT_LENGTH = 2048;

const SENTINEL_ORIGIN = "http://mission-control.invalid";

const SIGN_IN_FLOW =
  /^\/(login|signup|verify|two-factor|forgot-password|reset-password)(\/|$)/;

/** A C0 control character, DEL, or a backslash anywhere in the raw value. */
function hasUnsafeCharacter(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

function isProtocolRelative(path: string): boolean {
  return path.startsWith("//") || path.startsWith("/\\");
}

/**
 * Return `raw` as a same-origin path (with its query and hash) when it is safe
 * to navigate to after sign-in, or `fallback` otherwise. Never throws.
 */
export function sanitizeNext(
  raw: unknown,
  fallback: string = DEFAULT_NEXT,
): string {
  if (typeof raw !== "string") return fallback;
  if (raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return fallback;
  if (!raw.startsWith("/") || isProtocolRelative(raw)) return fallback;
  if (hasUnsafeCharacter(raw)) return fallback;

  let url: URL;
  try {
    url = new URL(raw, SENTINEL_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== SENTINEL_ORIGIN) return fallback;

  const path = `${url.pathname}${url.search}${url.hash}`;
  if (isProtocolRelative(path)) return fallback;
  if (SIGN_IN_FLOW.test(url.pathname)) return fallback;
  return path;
}

/** The first value of a Next.js search param, which may arrive repeated. */
export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The sanitised destination a page was asked for: `?next=`, or `?returnTo=`
 * when `next` is absent, under the rules of `sanitizeNext`. `returnTo` is the
 * name the CLI's `oxagen auth login --signup` (apps/cli/src/auth/loopback-login.ts)
 * and the deprecated app put on /signup and /login, so a new account made from
 * the CLI or the desktop installer still comes back to the consent page. A
 * present `next` that is refused yields `fallback` and never falls through to
 * `returnTo`. Pages read the destination through this function only.
 */
export function readNext(
  params: Record<string, string | string[] | undefined>,
  fallback: string = DEFAULT_NEXT,
): string {
  return sanitizeNext(
    firstParam(params.next) ?? firstParam(params.returnTo),
    fallback,
  );
}

/** A sign-in-flow link that carries a sanitised destination forward, e.g. `/signup?next=%2Facme`. */
export function withNext(path: string, next: string): string {
  if (next === DEFAULT_NEXT) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}next=${encodeURIComponent(next)}`;
}
