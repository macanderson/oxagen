// The production app's canonical host (ADR-215, ARCHITECTURE.md §3.8). The app
// is canonical at oxagen.app and still answers on www.oxagen.app and
// app.oxagen.sh, and Caddyfile.alb sends all three names to this server. A page
// visit on a name that is not canonical moves to the same page on the one that
// is. A CanonicalHostUrl is that target: an https URL on the canonical origin,
// with no credentials and no fragment, written exactly as the URL parser writes
// it back. navigation.ts's redirectToCanonicalHost is the only thing that sends
// the browser to one.
import { getMetadataBase } from "./app-url";

declare const canonicalHostUrl: unique symbol;
/** Not exported: it reaches navigation.ts inside `CanonicalHostRedirect`. */
type CanonicalHostUrl = string & { readonly [canonicalHostUrl]: true };

/**
 * Every public host the production app answers on. The host of
 * `getMetadataBase()`, which the build inlines from `NEXT_PUBLIC_APP_URL`, is
 * the canonical one.
 */
const APP_HOSTS: ReadonlySet<string> = new Set([
  "oxagen.app",
  "www.oxagen.app",
  "app.oxagen.sh",
]);

/**
 * The host the app keeps for good (ADR-215). A redirect to it is permanent.
 * A redirect to any other host is temporary and uncached, so a browser that
 * saw one before the move cannot replay it afterwards and loop.
 */
const HOME_HOST = "oxagen.app";

/**
 * Paths a program calls rather than a person visits: Better Auth, SCIM, the
 * proxied API, and well-known metadata. They answer on every host, because a
 * redirect breaks each of their callers. A fetch drops its Authorization header
 * when a redirect crosses origins. An identity provider's SAML POST does not
 * follow one. A provider's OAuth callback has to land on the host the provider
 * has on file.
 */
const MACHINE_PATH = /^\/(api|\.well-known)(\/|$)/;

/** A page visit that has to move to the canonical host. */
export interface CanonicalHostRedirect {
  /** The same path and query on the canonical origin. */
  readonly url: CanonicalHostUrl;
  /** True when the target is the app's permanent home, `HOME_HOST`. */
  readonly permanent: boolean;
}

function isCanonicalHostUrl(
  raw: string,
  url: URL,
  canonical: URL,
): raw is CanonicalHostUrl {
  return (
    url.protocol === "https:" &&
    url.origin === canonical.origin &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.href === raw
  );
}

/**
 * Where a request goes to reach the canonical host, or null when it stays.
 *
 * Only a GET or HEAD for a page, on a production host that is not the
 * canonical one, moves. Local, staging, and test hosts are not in `APP_HOSTS`,
 * so nothing outside production redirects. A build whose origin names a host
 * outside `APP_HOSTS` (a staging or local `NEXT_PUBLIC_APP_URL`) redirects
 * nothing either, rather than sending production visitors to it. An origin
 * that does not parse falls back to oxagen.app, as the page metadata does,
 * and oxagen.app is then canonical.
 */
export function canonicalHostRedirect(request: {
  readonly method: string;
  /** The Host header: a name, maybe with a port. */
  readonly host: string;
  readonly pathname: string;
  /** `""` or a query string starting with `?`. */
  readonly search: string;
}): CanonicalHostRedirect | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const host = request.host.trim().toLowerCase().replace(/:\d+$/, "");
  if (!APP_HOSTS.has(host) || MACHINE_PATH.test(request.pathname)) return null;
  const canonical = getMetadataBase();
  if (!APP_HOSTS.has(canonical.host) || canonical.host === host) return null;
  // The path is set on a copy of the origin, never parsed against it. Parsed,
  // a request for `//evil.example` would resolve to another host. The result is
  // parsed once more from its text, which is what the browser does with the
  // Location header, and must still name the canonical origin.
  const target = new URL(canonical.origin);
  target.pathname = request.pathname;
  target.search = request.search;
  const raw = target.href;
  return isCanonicalHostUrl(raw, new URL(raw), canonical)
    ? { url: raw, permanent: canonical.host === HOME_HOST }
    : null;
}
