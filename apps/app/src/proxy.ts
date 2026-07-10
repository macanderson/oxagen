import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 renamed the `middleware` convention to `proxy`
// (docs/app/api-reference/file-conventions/proxy). This runs before routes
// render and does two things:
//   1. Permanently redirects the pre-rename onboarding URL to its new home.
//   2. Acts as the edge auth boundary: any page route requested without a
//      session cookie is redirected to /login. The session is still
//      validated server-side per request (lib/session.getSessionOrRedirect);
//      this guard ensures routes that lack a server-component check (or that
//      don't exist yet) can't be reached unauthenticated.

// Reachable without a session. Everything else is behind auth.
// /two-factor is the sign-in second-factor step: after password auth the user
// holds only a short-lived 2FA cookie (NOT a full session cookie), so the
// hasSession() guard below would bounce them to /login and wedge the flow.
const PUBLIC_PATHS = [
  /^\/login(?:\/|$)/,
  /^\/signup(?:\/|$)/,
  /^\/verify(?:\/|$)/,
  /^\/two-factor(?:\/|$)/,
];

// Better Auth names the session cookie `<cookiePrefix>.session_token` and adds
// a `__Secure-` prefix over HTTPS. Match any *session_token cookie so the
// guard is robust to the prefix and to the secure variant.
function hasSession(request: NextRequest): boolean {
  return request.cookies.getAll().some((c) => c.name.endsWith("session_token") && c.value !== "");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // 1. Permanent redirect of the pre-rename onboarding URL. The dynamic org
  //    route segment was renamed but NOT reshaped (`/acme/...` resolves
  //    identically), so the only literal path that moved is this entrypoint.
  if (pathname === "/new-tenant" || pathname.startsWith("/new-tenant/")) {
    const dest = pathname.replace(/^\/new-tenant/, "/new-organization");
    // 308 = permanent + method-preserving (the modern permanent redirect).
    return NextResponse.redirect(new URL(`${dest}${search}`, request.url), 308);
  }

  // 2. v1 → v2 workspace route renames (§16 of the IA spec).
  //    Pattern: /{org}/{ws}/{old}(/{rest})? → /{org}/{ws}/{new}(/{rest})?
  //    Uses 301 (permanent, GET-preserving) per spec — these routes moved for good.
  //    The Automation feature areas (playbooks, workflows, runs) were removed,
  //    so their legacy redirects are gone too — old links fall through to a 404
  //    rather than a dead redirect. Activity has since been reintroduced at
  //    /{org}/{ws}/activity (2026-07-09) as a new route, not a redirect target.
  {
    const wsRouteMove = pathname.match(/^(\/[^/]+\/[^/]+)\/(.*)$/);
    if (wsRouteMove) {
      const wsBase = wsRouteMove[1] ?? "";
      const rest = wsRouteMove[2] ?? "";
      let dest: string | null = null;
      if (rest === "chat" || rest.startsWith("chat/")) {
        dest = "ask";
      }
      if (dest) {
        return NextResponse.redirect(new URL(`${wsBase}/${dest}${search}`, request.url), 301);
      }
    }
  }

  // 3. Surface the request URL on a request header so RSCs and layouts can
  //    read pathname + search reliably. Next.js does NOT expose either to RSC
  //    natively — the slug-history resolver (OXA-1779) needs them to build a
  //    redirect URL that preserves the rest of the path and the query.
  const downstreamHeaders = new Headers(request.headers);
  downstreamHeaders.set("x-url", request.nextUrl.pathname + request.nextUrl.search);

  // 4. Public pages need no session.
  if (PUBLIC_PATHS.some((re) => re.test(pathname))) {
    return NextResponse.next({ request: { headers: downstreamHeaders } });
  }

  // 5. Auth boundary for every other matched (page) route.
  if (!hasSession(request)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next({ request: { headers: downstreamHeaders } });
}

export const config = {
  // Run on page routes only — exclude Next internals, static assets, and all
  // API routes (`/api/auth/*` must stay reachable to establish a session, and
  // other API routes enforce their own auth).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
