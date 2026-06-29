import { Hono } from "hono";
import type { AppEnv } from "../../app";

/**
 * GET /v1/auth/whoami — transport-level credential probe + identity echo.
 *
 * Answers one question for the caller: "are my credentials valid, and what
 * scope do they carry?" This is the canonical validation probe for the CLI's
 * `oxagen login` and any machine client holding a platform API key.
 *
 * Why a dedicated route instead of reusing user.preferences.read / org.list /
 * workspace.list: every one of those capability handlers hard-requires
 * `ctx.userId` and throws "requires an authenticated user" when it is absent.
 * An API key authenticates as a MACHINE — authMiddleware sets `userId: null`
 * and pre-binds `orgId`/`workspaceId` from the key — so those handlers throw a
 * plain Error that the kernel re-raises and errorMiddleware surfaces as HTTP
 * 500. Every probe against them therefore fails for a perfectly valid key.
 * After the resolveApiKey prefix-window fix in #289 made keys resolve, this was
 * the *remaining* reason CLI API-key login still failed.
 *
 * This is auth infrastructure, not a metered capability — like /health it does
 * no business work and calls no `invoke()`. authMiddleware has already done the
 * real work: it returns 401 for a missing/malformed/invalid/expired credential
 * before this handler ever runs. Reaching the handler at all PROVES the
 * credential is valid; the handler only echoes the identity authMiddleware
 * resolved. Works identically for session and API-key auth.
 */
export const authWhoamiRoute = new Hono<AppEnv>();

authWhoamiRoute.get("/", (c) => {
  const userId = c.get("userId");
  const apiKeyId = c.get("apiKeyId");
  return c.json({
    authenticated: true,
    // Exactly one of these is set: session auth carries `userId`; API-key auth
    // carries `apiKeyId`. The pair tells the caller which credential type the
    // platform accepted.
    userId: userId ?? null,
    apiKeyId: apiKeyId ?? null,
    // Scope is present for API-key auth (the key pre-binds org + workspace) and
    // null for a bare session that has not yet selected an org/workspace.
    orgId: c.get("orgId") ?? null,
    workspaceId: c.get("workspaceId") ?? null,
  });
});
