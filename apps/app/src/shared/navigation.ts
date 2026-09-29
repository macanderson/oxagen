import type { LinearAuthorizationUrl } from "./linear-authorization-url";
// The only module that performs a redirect (ARCHITECTURE.md §3.8, INV-13).
// Every target is a branded value: a SafePath from sanitizeNext or a route
// builder, a LoopbackUri from parseLoopbackUri, an ExternalCheckoutUrl from
// parseCheckoutUrl, a LinearAuthorizationUrl from parseLinearAuthorizationUrl,
// or a CanonicalHostUrl from canonicalHostRedirect. The lint rule in
// eslint.config.mjs refuses redirect, permanentRedirect, NextResponse.redirect
// and Response.redirect everywhere else under src/.
import { permanentRedirect, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { CanonicalHostRedirect } from "./canonical-host";
import type { ExternalCheckoutUrl } from "./checkout-url";
import type { LoopbackUri } from "./loopback-uri";
import type { SafePath } from "./safe-path";

export function redirectTo(path: SafePath): never {
  redirect(path);
}

/** A 308 to the canonical URL of a renamed organization or workspace. */
export function permanentRedirectTo(path: SafePath): never {
  permanentRedirect(path);
}

/** Hands the CLI its authorization code, or its refusal, on the loopback listener. */
export function redirectToLoopback(
  uri: LoopbackUri,
  query:
    | { code: string; state: string }
    | { error: "access_denied"; state: string },
): never {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  redirect(url.href);
}

/** Sends the browser to the Stripe Checkout page a purchase opened. */
export function redirectToCheckout(url: ExternalCheckoutUrl): never {
  redirect(url);
}

/** A 307 from a route handler or the proxy; a 308 for a route that moved for good (the proxy's Appendix F table). */
export function responseRedirect(
  request: Request,
  path: SafePath,
  status: 307 | 308 = 307,
): NextResponse {
  return NextResponse.redirect(new URL(path, publicOrigin(request)), status);
}

const HOST_HEADER = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * The origin the visitor asked for. In a route handler, Next's standalone
 * server builds `request.url` from the address it listens on, so a redirect
 * resolved against it sent production visitors to https://localhost:3000.
 * Caddy passes the visitor's Host header through and routes only the app's
 * own names here. The scheme still comes from `request.url`, which Next takes
 * from X-Forwarded-Proto.
 */
function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  return host !== null && HOST_HEADER.test(host)
    ? `${url.protocol}//${host}`
    : url.origin;
}

/**
 * A page visit on a production host that is not the canonical one, sent to the
 * same page there (ADR-215). A permanent move is cached for an hour, the cap
 * the static sites' edge redirects use, so a wrong target clears on its own. A
 * temporary one is not cached at all.
 */
export function redirectToCanonicalHost(
  target: CanonicalHostRedirect,
): NextResponse {
  const res = NextResponse.redirect(target.url, target.permanent ? 308 : 307);
  res.headers.set(
    "cache-control",
    target.permanent ? "public, max-age=3600" : "no-store",
  );
  return res;
}

export function redirectToLinearAuthorization(
  url: LinearAuthorizationUrl,
): never {
  redirect(url);
}
