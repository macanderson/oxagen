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
const PUBLIC_PATHS = [/^\/login(?:\/|$)/, /^\/signup(?:\/|$)/, /^\/verify(?:\/|$)/];

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
  //    Pattern: /{org}/{ws}/{old-segment}(/{rest})? → /{org}/{ws}/{new-segment}(/{rest})?
  //    Uses 301 (permanent, GET-preserving) per spec — these routes moved for good.
  {
    const wsRouteMove = pathname.match(
      /^(\/[^/]+\/[^/]+)\/(executions|agents|playbooks)(\/.*)?$/,
    );
    if (wsRouteMove) {
      const [, wsBase, segment, rest = ""] = wsRouteMove;
      const newSegment =
        segment === "executions"
          ? "activity/runs"
          : segment === "agents"
            ? "automation/agents"
            : "automation/playbooks";
      return NextResponse.redirect(
        new URL(`${wsBase}/${newSegment}${rest}${search}`, request.url),
        301,
      );
    }
  }

  // 3. Public pages need no session.
  if (PUBLIC_PATHS.some((re) => re.test(pathname))) return NextResponse.next();

  // 4. Auth boundary for every other matched (page) route.
  if (!hasSession(request)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Run on page routes only — exclude Next internals, static assets, and all
  // API routes (`/api/auth/*` must stay reachable to establish a session, and
  // other API routes enforce their own auth).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
