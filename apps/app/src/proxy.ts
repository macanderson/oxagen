// Request interception (Next 16 `proxy`, formerly `middleware`). Cookies and
// redirects only: no Node built-ins, database calls or secrets.
//
// It answers a legacy route with a 308 to the page that absorbed it (the
// Appendix F table in shared/legacy-routes.ts, ARCHITECTURE.md §7.3), then acts
// as the minimal session gate: it checks that a session cookie exists; the real
// session and membership check is `requireViewer` in every layout and page.
import { type NextRequest, NextResponse } from "next/server";
import { LEGACY_ROUTES } from "@/shared/legacy-routes";
import { responseRedirect } from "@/shared/navigation";
import { routes, type SafePath, sanitizeNext } from "@/shared/safe-path";

/**
 * Reachable without a session: the sign-in flows, invitations, the auth API and
 * the two callbacks. Two-factor is public because after the password step the
 * person holds only Better Auth's short-lived two-factor cookie; the proxy
 * still sends a visitor with neither that cookie nor a session to /login. The CLI and
 * GitHub callbacks are public so an invalid CLI request renders its error
 * without a detour, and each sends a signed-out visitor to /login itself with
 * the exact request as `next`. /cli/complete is public because the browser the
 * CLI's loopback listener 302s there may hold no app cookie at all — the token
 * is already in the terminal — so a gate would end a successful sign-in on
 * /login (#3091). Organization creation (/new-organization) is not public.
 * /api/scim/v2 is public because an identity provider calls it with the
 * organization's SCIM bearer token and never a cookie; the Hono API the app
 * proxies it to refuses a request without a valid token (#3734).
 */
export const PUBLIC_PATHS: readonly RegExp[] = [
  /^\/(login|signup|verify|two-factor|forgot-password|reset-password)(\/|$)/,
  /^\/invite\//,
  /^\/api\/auth\//,
  /^\/api\/scim\/v2(\/|$)/,
  /^\/cli\/(authorize|complete)(\/|$)/,
  /^\/github\/setup(\/|$)/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}

/**
 * Better Auth names its cookie `<prefix>.session_token`, with a `__Secure-`
 * prefix over HTTPS; match any non-empty `*session_token`.
 */
export function hasSessionCookie(req: NextRequest): boolean {
  return req.cookies
    .getAll()
    .some((c) => c.name.endsWith("session_token") && c.value !== "");
}

/**
 * Better Auth's short-lived cookie between the password and the second factor:
 * `<prefix>.two_factor`, with a `__Secure-` prefix over HTTPS. Its value is
 * signed and checked by the two-factor endpoints; here only its presence counts.
 */
export function hasTwoFactorCookie(req: NextRequest): boolean {
  return req.cookies
    .getAll()
    .some((c) => c.name.endsWith("two_factor") && c.value !== "");
}

const TWO_FACTOR_PATH = /^\/two-factor(\/|$)/;

/**
 * Two-factor is read only after a first factor (two-factor.md, Permissions):
 * the password step's two-factor cookie, or a session, which the enrollment
 * redirect (`routes.mfaEnroll`) carries. Without either the visitor goes to
 * /login, keeping the destination the page was given.
 */
function twoFactorWithoutFirstFactor(req: NextRequest): NextResponse | null {
  if (!TWO_FACTOR_PATH.test(req.nextUrl.pathname)) return null;
  if (hasTwoFactorCookie(req) || hasSessionCookie(req)) return null;
  const next = sanitizeNext(
    req.nextUrl.searchParams.get("next"),
    routes.root(),
  );
  return responseRedirect(req, routes.login(next));
}

/**
 * Each row compiled once: `from` as an anchored pattern with `org` and `ws`
 * named groups, `to` as its replacement string.
 */
const LEGACY = LEGACY_ROUTES.map(({ from, to }) => ({
  pattern: new RegExp(
    `^${from
      .replace("/**", "(?:/.*)?")
      .replace(/\{(org|ws)\}/g, (_, name: string) => `(?<${name}>[^/]+)`)
      .replace("{id}", "[^/]+")}$`,
  ),
  target: to.replace(/\{(org|ws)\}/g, (_, name: string) => `$<${name}>`),
}));

/** The §1.2 page a legacy route moved to, or null when no row matches. */
function legacyTarget(pathname: string): SafePath | null {
  const row = LEGACY.find(({ pattern }) => pattern.test(pathname));
  return row === undefined
    ? null
    : sanitizeNext(pathname.replace(row.pattern, row.target), routes.root());
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  const signedOut = twoFactorWithoutFirstFactor(req);
  if (signedOut !== null) return signedOut;
  if (isPublicPath(pathname)) return NextResponse.next();
  const moved = legacyTarget(pathname);
  if (moved !== null) return responseRedirect(req, moved, 308);
  if (hasSessionCookie(req)) return NextResponse.next();
  // Better Auth's default OAuth error page redirects to `/?error=<code>`. Lift
  // that code onto /login so LoginForm can show it. Without this, the error is
  // buried in `?next=/?error=…` and every failed Google/GitHub attempt looks
  // like a blank login page.
  const oauthError = req.nextUrl.searchParams.get("error");
  if (pathname === "/" && oauthError !== null && oauthError !== "") {
    return responseRedirect(req, routes.loginWithOAuthError(oauthError));
  }
  const next = sanitizeNext(`${pathname}${search}`, routes.root());
  return responseRedirect(req, routes.login(next));
}

export const config = {
  matcher: [
    "/((?!_next/|favicon|robots|manifest|fonts/|brand/|pwa/|social/|spinner/).*)",
  ],
};
