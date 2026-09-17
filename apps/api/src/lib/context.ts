import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type CapabilityContext, ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import { requireEnv } from "@oxagen/config/env";
import { extractTrustedClientIp } from "@oxagen/oxagen/client-ip";
import type { AppEnv } from "../app";

/**
 * How many proxies sit between the client and this process, resolved from the
 * validated env once and memoized. Wrapped in a function (called at first
 * request, not module load) so importing the app never triggers env access —
 * mirroring `rateLimitBudgets()` in middleware/distributed-rate-limit.ts.
 */
let cachedTrustedProxyHops: number | null = null;
function trustedProxyHops(): number {
  if (cachedTrustedProxyHops !== null) return cachedTrustedProxyHops;
  const env = requireEnv(["TRUSTED_PROXY_HOP_COUNT"] as const);
  cachedTrustedProxyHops = env.TRUSTED_PROXY_HOP_COUNT;
  return cachedTrustedProxyHops;
}

/**
 * The client IP this deployment is willing to authorize on, or null.
 *
 * The derivation itself is `extractTrustedClientIp` in
 * `@oxagen/oxagen/client-ip`, shared with apps/app, apps/mcp and the rate
 * limiter so a mandate decision cannot disagree with a bucket key about who the
 * caller is. That file carries the reasoning: which headers are believed in
 * which deployment shape, why the forwarded chain is walked from the right, and
 * why `x-real-ip` is not consulted at all.
 *
 * This value feeds the IAM `ip_ranges` / `ip_allow` conditions
 * (packages/oxagen/src/iam/conditions.ts), which ALLOW on a CIDR match. It is
 * an authorization signal and never an authentication one.
 *
 * Exported so the derivation stays unit-testable at this seam the way
 * `deriveBucketKey` is in middleware/distributed-rate-limit.ts.
 */
export function extractClientIp(c: Context<AppEnv>): string | null {
  return extractTrustedClientIp((name) => c.req.header(name), {
    trustedProxyHops: trustedProxyHops(),
    onVercel: process.env.VERCEL === "1",
  });
}

/** Test seam: drop the memoized hop count so a case can set a different env. */
export function __resetTrustedProxyHopsForTests(): void {
  cachedTrustedProxyHops = null;
}

/**
 * Build the capability context for a request.
 *
 * The two scopes are checked separately because a route can legitimately need
 * one and not the other. Creating a workspace is the case that forced this:
 * it needs an org and cannot need a workspace, since the caller is asking for
 * their first one. `requireOrg: false` used to switch off both checks, so the
 * only choices were "both" or "neither" — and a bootstrap route had to take
 * "neither", losing the org check it did want (#1203).
 *
 * `requireWorkspace` defaults to whatever `requireOrg` is, so the two existing
 * shapes — no options, and `{ requireOrg: false }` — behave exactly as before.
 */
export function capabilityContext(
  c: Context<AppEnv>,
  options: { requireOrg?: boolean; requireWorkspace?: boolean } = {},
): CapabilityContext {
  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  const { requireOrg = true, requireWorkspace = requireOrg } = options;
  if (requireOrg && !orgId) {
    throw new HTTPException(400, { message: "Org scope required" });
  }
  if (requireWorkspace && !workspaceId) {
    throw new HTTPException(400, { message: "Workspace scope required" });
  }
  return {
    orgId: orgId ?? "",
    // A route mounted org-only reaches a scoped capability, and the kernel
    // enters a tenant scope that asserts a uuid, so an empty workspace id is
    // refused before the handler runs. The org-only sentinel is what such a
    // call carries, the same constant the app's kernel seam uses (#3029).
    workspaceId: workspaceId ?? (orgId ? ORG_ONLY_WORKSPACE_ID : ""),
    userId: c.get("userId") ?? null,
    apiKeyId: c.get("apiKeyId") ?? null,
    // Must be a valid UUID: it flows into non-nullable ClickHouse UUID columns
    // (execution_logs.execution_id, audit_events.request_id). The logger
    // middleware sets a randomUUID per request; the fallback guards any route
    // reached before it runs so we never write "" into a UUID column.
    requestId: c.get("requestId") ?? crypto.randomUUID(),
    surface: "api",
    messageId: null,
    clientIp: extractClientIp(c),
  };
}
