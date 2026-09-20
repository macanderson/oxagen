// The Better Auth API route handler, carried over from apps/app_deprecated/src/
// app/api/auth/[...all]/route.ts. Better Auth's handler is a plain fetch
// handler; apps/app reaches this module through its session seam
// (apps/app/src/server/session.ts), the one app module that imports
// @oxagen/auth.
//
// A failed or rate-limited sign-in attempt emits `auth.sign_in_failed` (SOC 2
// CC6: brute-force lockouts must be auditable).

import { requireEnv } from "@oxagen/config/env";
import { extractTrustedClientIp } from "@oxagen/oxagen/client-ip";

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

/**
 * Whether the edge-written `x-oxagen-client-ip` header is believed, resolved
 * from the validated env once and memoized. Off by
 * default: the header is only trustworthy once the Caddy config that SETS it is
 * deployed, and that ships through a different pipeline than this code. See
 * packages/oxagen/src/client-ip.ts.
 */
let cachedTrustEdgeHeader: boolean | null = null;
function trustEdgeHeader(): boolean {
  if (cachedTrustEdgeHeader !== null) return cachedTrustEdgeHeader;
  cachedTrustEdgeHeader = requireEnv([
    "TRUST_EDGE_CLIENT_IP_HEADER",
  ] as const).TRUST_EDGE_CLIENT_IP_HEADER;
  return cachedTrustEdgeHeader;
}

/**
 * The proxies this deployment trusts, by identity rather than by count.
 * Memoized on the same terms as the flag above. This is the only thing that
 * can attribute an address off Vercel once the edge header is out of the
 * picture — counting hops was deleted in #3205.
 */
let cachedTrustedProxyCidrs: string[] | null = null;
function trustedProxyCidrs(): string[] {
  if (cachedTrustedProxyCidrs !== null) return cachedTrustedProxyCidrs;
  cachedTrustedProxyCidrs = requireEnv(["TRUSTED_PROXY_CIDRS"] as const)
    .TRUSTED_PROXY_CIDRS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return cachedTrustedProxyCidrs;
}

/** Test seam: drop the memoized proxy config so a case can set a different env. */
export function __resetTrustedProxyHopsForTests(): void {
  cachedTrustEdgeHeader = null;
  cachedTrustedProxyCidrs = null;
}

/**
 * The address stamped onto an `auth.sign_in_failed` audit record, through the
 * one shared derivation (ADR-083).
 *
 * This read the LEFTMOST `x-forwarded-for` entry and then `x-real-ip`, both of
 * which a caller writes for itself behind the ALB. That is not an authorization
 * bypass here — nothing downstream of this gates on the value — but an audit
 * record naming an address the attacker chose is worse than one naming none,
 * because it is the record someone reaches for after the fact.
 *
 * Reached this tree in the app cutover (ADR-081), which moved the audited
 * auth route out of `apps/app` and into this package. The same defect had
 * already been fixed in `apps/api`, `apps/app` and `apps/mcp`; this is the
 * fifth copy, and the reason the derivation now lives in one place.
 */
export function clientAddress(headers: Headers): string | null {
  return extractTrustedClientIp((name) => headers.get(name), {
    trustedProxyCidrs: trustedProxyCidrs(),
    trustEdgeHeader: trustEdgeHeader(),
    onVercel: process.env.VERCEL === "1",
  });
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
    import("./auth"),
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
