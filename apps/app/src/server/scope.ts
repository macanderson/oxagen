// requireViewer: the session and membership check every [org] layout, page and
// server action runs (plan §4.6). The proxy only checks that a session cookie
// exists; this is the real gate.
//
//   no session              → redirect to /login
//   unknown org / workspace → notFound()
//   non-member              → notFound(), indistinguishable from an unknown slug
//   historical slug         → 308 to the canonical URL, rest of the path kept
//   MFA enrollment overdue  → redirect to MFA_ENROLL_PATH
//
// A member who lacks a permission is not an exception here: the read port
// returns { reason: "denied" } and PageState renders it.
import "server-only";
import { headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { isFixtureMode } from "./fixture-session";
import { fixtureTenancyLookups } from "./fixture-tenancy";
import { MFA_ENROLL_PATH } from "./mfa-gate";
import { getSession } from "./session";
import { liveTenancyLookups, type TenancyLookups } from "./tenancy-lookups";
import {
  canonicalPath,
  resolveViewerWith,
  type Viewer,
  type ViewerResolution,
} from "./viewer-resolution";

export { ORG_ONLY_WS, type Scope } from "./tenant-scope";
export type { Viewer, ViewerResolution } from "./viewer-resolution";

/** The fixture lookups in dev/e2e fixture mode; the database otherwise, always in production. */
export function tenancyLookups(): TenancyLookups {
  return isFixtureMode() ? fixtureTenancyLookups : liveTenancyLookups;
}

/** Resolve without throwing a navigation interrupt: route handlers map the result to a Response. */
export const resolveViewer = cache(
  async (orgSlug: string, wsSlug?: string): Promise<ViewerResolution> => {
    const session = await getSession();
    // The MFA deadline is judged against the request's clock. Under partial
    // prefetching a runtime prerender resolves cookies but not the clock, so
    // `new Date()` straight after the session read is a blocking-prerender
    // error; connection() defers it to the request.
    await connection();
    return resolveViewerWith(
      { session, lookups: tenancyLookups(), now: new Date() },
      orgSlug,
      wsSlug,
    );
  },
);

/**
 * The request's path and query, when the platform exposes it. `x-url` is set by
 * the proxy when present; `next-url` is Next's header on client navigations.
 * Null when neither is present: the redirect then lands on the canonical root.
 */
export async function requestUrl(): Promise<{
  pathname: string;
  search: string;
} | null> {
  const h = await headers();
  const raw = h.get("x-url") ?? h.get("next-url");
  if (!raw) return null;
  try {
    const url = new URL(raw, "http://internal.invalid");
    return { pathname: url.pathname, search: url.search };
  } catch {
    return null;
  }
}

export const requireViewer = cache(
  async (orgSlug: string, wsSlug?: string): Promise<Viewer> => {
    const result = await resolveViewer(orgSlug, wsSlug);
    switch (result.kind) {
      case "ok":
        return result.viewer;
      case "unauthenticated":
        return redirect("/login");
      case "not_found":
        return notFound();
      case "mfa_enroll":
        return redirect(MFA_ENROLL_PATH);
      case "redirect": {
        const url = await requestUrl();
        return permanentRedirect(
          canonicalPath({
            pathname: url?.pathname ?? "",
            search: url?.search ?? "",
            base: "/",
            from: { org: orgSlug, ws: wsSlug ?? null },
            to: { org: result.org, ws: result.ws },
          }),
        );
      }
    }
  },
);
