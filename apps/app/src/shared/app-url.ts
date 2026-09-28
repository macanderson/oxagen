// The app's own public origin. Pure and edge-safe (§2): `NEXT_PUBLIC_*` and
// `NODE_ENV` are inlined at build, so it reads the same wherever it is called.
//
// Next resolves a relative `openGraph` / `twitter` image URL against
// `metadata.metadataBase`, and with no base it falls back to
// `http://localhost:3000` — which is what production advertised as its
// `og:image` until the root layout passed this origin in (#3076, #3091).

/** Where the app is served when nothing says otherwise. */
const PROD_APP_URL = "https://app.oxagen.sh";
const DEV_APP_URL = "http://localhost:3000";

/**
 * The app origin, with any trailing slash stripped. Internal: `getMetadataBase`
 * is the one thing that needs it, and an exported second spelling of the origin
 * is a second place for it to drift.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_APP_URL` — an explicit override wins in any environment.
 *   2. `NODE_ENV === "development"` → the local dev server on :3000.
 *   3. otherwise (production, preview, test) → `https://app.oxagen.sh`.
 */
function appBaseUrl(): string {
  const override = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (override !== undefined && override !== "")
    return override.replace(/\/+$/, "");
  return process.env.NODE_ENV === "development" ? DEV_APP_URL : PROD_APP_URL;
}

/**
 * The origin as a `URL` for `metadata.metadataBase`.
 *
 * An override that is not a URL — a stray quote, a bare hostname — falls back
 * to the environment default rather than throwing out of `generateMetadata`
 * and failing every render of the root layout.
 */
export function getMetadataBase(): URL {
  try {
    return new URL(appBaseUrl());
  } catch {
    return new URL(
      process.env.NODE_ENV === "development" ? DEV_APP_URL : PROD_APP_URL,
    );
  }
}

/**
 * Every public host the production app answers on. The app is moving from
 * app.oxagen.sh to oxagen.app (ADR-215), and Caddyfile.alb sends all three
 * names to this server. The host of the origin above is the canonical one.
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
export interface HostRedirect {
  /** The same path and query on the canonical origin. */
  readonly location: URL;
  /** True when the target is the app's permanent home, `HOME_HOST`. */
  readonly permanent: boolean;
}

/**
 * Where a request goes to reach the canonical host, or null when it stays.
 *
 * Only a GET or HEAD for a page, on a production host that is not the
 * canonical one, moves. Local, staging, and test hosts are not in `APP_HOSTS`,
 * so nothing outside production redirects. A build whose origin is not a
 * production host (a mistyped `NEXT_PUBLIC_APP_URL`) redirects nothing either,
 * rather than sending production visitors to it.
 */
export function canonicalHostRedirect(request: {
  readonly method: string;
  /** The Host header: a name, maybe with a port. */
  readonly host: string;
  readonly pathname: string;
  /** `""` or a query string starting with `?`. */
  readonly search: string;
}): HostRedirect | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const host = request.host.trim().toLowerCase().replace(/:\d+$/, "");
  if (!APP_HOSTS.has(host) || MACHINE_PATH.test(request.pathname)) return null;
  const canonical = getMetadataBase();
  if (!APP_HOSTS.has(canonical.host) || canonical.host === host) return null;
  // The path is set on a copy of the origin, never parsed against it. Parsed,
  // a request for `//evil.example` would resolve to another host.
  const location = new URL(canonical.origin);
  location.pathname = request.pathname;
  location.search = request.search;
  return { location, permanent: canonical.host === HOME_HOST };
}
