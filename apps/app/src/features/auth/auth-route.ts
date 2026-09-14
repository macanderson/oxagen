// The Better Auth API route, carried over from apps/app_deprecated/src/app/api/
// auth/[...all]/route.ts. Better Auth's handler is a plain fetch handler, so the
// route calls it directly (the app does not depend on better-auth itself).
//
// A failed or rate-limited sign-in attempt emits `auth.sign_in_failed` (SOC 2
// CC6: brute-force lockouts must be auditable). Fixture mode has no Better Auth
// to talk to, so the route answers 404 there instead of loading an auth server
// whose env the fixture dev server does not carry.
import "server-only";
import { isFixtureMode } from "@/server/fixture-session";

/** Security events before a session exists carry the org sentinel (packages/auth/src/auth.ts). */
export const NO_ORG_SENTINEL = "00000000-0000-0000-0000-000000000000";

export function isSignInPath(pathname: string): boolean {
  return (
    pathname.includes("/sign-in/email") ||
    pathname.includes("/sign-in/social") ||
    pathname.includes("/two-factor/verify-") ||
    pathname.includes("/callback/")
  );
}

export function isAuditedFailure(pathname: string, status: number): boolean {
  return (
    isSignInPath(pathname) &&
    (status === 401 || status === 403 || status === 429)
  );
}

export function clientAddress(headers: Headers): string | null {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    null
  );
}

type SecurityEmitter = (event: {
  eventType: "auth.sign_in_failed";
  actorUserId: null;
  orgId: string;
  workspaceId: null;
  capability: null;
  outcome: "deny";
  ip: string | null;
  userAgent: string | null;
  requestId: null;
}) => void;

export type AuthRouteDeps = {
  handler: (request: Request) => Promise<Response>;
  emitSecurityEvent: SecurityEmitter;
};

async function loadDeps(): Promise<AuthRouteDeps> {
  const [{ auth }, { emitSecurityEvent }] = await Promise.all([
    import("@oxagen/auth/server"),
    import("@oxagen/database/security"),
  ]);
  return {
    handler: (request) => auth.handler(request),
    emitSecurityEvent: emitSecurityEvent,
  };
}

export async function handleAuthRequest(
  request: Request,
  deps?: AuthRouteDeps,
): Promise<Response> {
  if (!deps && isFixtureMode()) return new Response(null, { status: 404 });
  const { handler, emitSecurityEvent } = deps ?? (await loadDeps());
  const response = await handler(request);
  if (
    request.method === "POST" &&
    isAuditedFailure(new URL(request.url).pathname, response.status)
  ) {
    emitSecurityEvent({
      eventType: "auth.sign_in_failed",
      actorUserId: null,
      orgId: NO_ORG_SENTINEL,
      workspaceId: null,
      capability: null,
      outcome: "deny",
      ip: clientAddress(request.headers),
      userAgent: request.headers.get("user-agent"),
      requestId: null,
    });
  }
  return response;
}
