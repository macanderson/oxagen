// The only module that performs a redirect (ARCHITECTURE.md §3.8, INV-13).
// Every target is a branded value: a SafePath from sanitizeNext or a route
// builder, or a LoopbackUri from parseLoopbackUri. The lint rule in
// eslint.config.mjs refuses redirect, permanentRedirect, NextResponse.redirect
// and Response.redirect everywhere else under src/.
import { permanentRedirect, redirect } from "next/navigation";
import { NextResponse } from "next/server";
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

/** A 307 from a route handler or the proxy. */
export function responseRedirect(
  request: Request,
  path: SafePath,
): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}
