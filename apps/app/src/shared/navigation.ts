import type { LinearAuthorizationUrl } from "./linear-authorization-url";
// The only module that performs a redirect (ARCHITECTURE.md §3.8, INV-13).
// Every target is a branded value: a SafePath from sanitizeNext or a route
// builder, a LoopbackUri from parseLoopbackUri, or an ExternalCheckoutUrl from
// parseCheckoutUrl. The lint rule in eslint.config.mjs refuses redirect,
// permanentRedirect, NextResponse.redirect and Response.redirect everywhere
// else under src/.
import { permanentRedirect, redirect } from "next/navigation";
import { NextResponse } from "next/server";
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
  return NextResponse.redirect(new URL(path, request.url), status);
}

export function redirectToLinearAuthorization(
  url: LinearAuthorizationUrl,
): never {
  redirect(url);
}
