// Request interception (Next 16 `proxy`, formerly `middleware`). Cookies and
// redirects only: no Node built-ins, database calls or secrets.
//
// This is the minimal session gate. It checks that a session cookie exists; the
// real session and membership check is `requireViewer` in every layout and page.
// Appendix F legacy redirects are added at cutover (plan §4.11, Batch 5).
import { type NextRequest, NextResponse } from "next/server";
import {
  FIXTURE_SESSION_COOKIE,
  readFixtureSession,
} from "@/server/fixture-session";

/** Reachable without a session: the sign-in flows, invitations, auth API and callbacks. */
export const PUBLIC_PATHS: readonly RegExp[] = [
  /^\/(login|signup|verify|two-factor|forgot-password|reset-password)(\/|$)/,
  /^\/invite\//,
  /^\/api\/auth\//,
  /^\/cli\/authorize(\/|$)/,
  /^\/github\/setup(\/|$)/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}

/**
 * Better Auth names its cookie `<prefix>.session_token`, with a `__Secure-`
 * prefix over HTTPS; match any non-empty `*session_token`. In fixture mode the
 * dev-only fixture session cookie also counts (never in a production build).
 */
export function hasSessionCookie(req: NextRequest): boolean {
  const cookies = req.cookies.getAll();
  if (cookies.some((c) => c.name.endsWith("session_token") && c.value !== ""))
    return true;
  return (
    readFixtureSession(req.cookies.get(FIXTURE_SESSION_COOKIE)?.value) !== null
  );
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (hasSessionCookie(req)) return NextResponse.next();
  const login = new URL("/login", req.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/((?!_next/|favicon|robots|manifest|fonts/|brand/|pwa/|social/|spinner/).*)",
  ],
};
