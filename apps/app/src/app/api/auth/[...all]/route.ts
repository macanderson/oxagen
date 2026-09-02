// Node runtime — this route uses @oxagen/database (pg driver) which requires
// Node.js built-ins. Keep it out of Edge; do NOT add `export const runtime`.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { NextRequest } from "next/server";

// Sentinel for events that fire before a user session is established (e.g.
// failed sign-in with unknown email). Mirrors the value in packages/auth/src/auth.ts.
const NO_ORG_SENTINEL = "00000000-0000-0000-0000-000000000000";

/** Paths that constitute a sign-in attempt for audit purposes. */
function isSignInPath(pathname: string): boolean {
  return (
    pathname.includes("/sign-in/email") ||
    pathname.includes("/sign-in/social") ||
    // Callback leg of OAuth social sign-in.
    pathname.includes("/callback/")
  );
}

const { GET, POST: _baPost } = toNextJsHandler(auth.handler);

/**
 * Wrap the Better Auth POST handler so that failed sign-in attempts emit an
 * `auth.sign_in_failed` security event. Coverage:
 *   - 401 / 403 responses on /sign-in/email, /sign-in/social, /callback/*
 *   - 429 (rate-limited) responses on sign-in paths — brute-force lockouts
 *     must be auditable per SOC2 CC6.
 *
 * All other paths are passed through unchanged.
 */
async function POST(request: NextRequest): Promise<Response> {
  const response = await _baPost(request);

  const { pathname } = new URL(request.url);
  const status = response.status;

  // Emit audit event for failed sign-in (401/403) and rate-limit (429) hits.
  if (
    isSignInPath(pathname) &&
    (status === 401 || status === 403 || status === 429)
  ) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      null;
    const userAgent = request.headers.get("user-agent") ?? null;

    emitSecurityEvent({
      eventType: "auth.sign_in_failed",
      actorUserId: null,
      orgId: NO_ORG_SENTINEL,
      workspaceId: null,
      capability: null,
      outcome: "deny",
      ip,
      userAgent,
      requestId: null,
    });
  }

  return response;
}

export { GET, POST };
