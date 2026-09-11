import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requireEnv } from "@oxagen/config/env";
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
 * The client IP as reported by the last proxy this deployment trusts.
 *
 * Each proxy APPENDS the address it received the request from, so
 * x-forwarded-for reads oldest-first and the entries a client sent itself sit
 * on the LEFT. Behind an ALB, `xff.split(",")[0]` is therefore whatever the
 * caller typed into the header — and this value feeds the IAM `ip_ranges` /
 * `ip_allow` conditions (packages/oxagen/src/iam/conditions.ts), which allow on
 * a CIDR match. One spoofed header entry satisfied an IP allowlist.
 *
 * With N trusted proxies the client's real address is the Nth entry from the
 * right, because those are the N entries the trusted proxies wrote themselves.
 * A client that prepends extra hops only lengthens the untrusted left-hand side
 * and cannot move the entry this picks.
 *
 * TRUSTED_PROXY_HOP_COUNT = 0 means nothing in front of this process rewrote
 * the header, so every entry is caller-supplied and none of it is usable.
 *
 * NOT an authentication signal, and — with the count set correctly — the
 * authorization signal the IP allowlist needs. A too-low count is what makes
 * that allowlist bypassable; too high yields a proxy's own address and fails
 * closed against a CIDR of real clients.
 *
 * Exported so the hop arithmetic can be unit-tested directly, the way
 * `deriveBucketKey` is in middleware/distributed-rate-limit.ts.
 */
export function extractClientIp(c: Context<AppEnv>): string | null {
  const hops = trustedProxyHops();
  const xff = c.req.header("x-forwarded-for");
  if (xff && hops > 0) {
    const chain = xff
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    // A chain shorter than the trusted-proxy count means a proxy did not append
    // what this deployment says it does; the leftmost entry is then the oldest
    // thing any trusted proxy could have written.
    const candidate = chain[Math.max(0, chain.length - hops)];
    if (candidate) return candidate;
  }
  // x-real-ip is set by a single reverse proxy and carries no chain to walk.
  // It is exactly as trustworthy as that proxy, and no more.
  const realIp = c.req.header("x-real-ip");
  return realIp?.trim() || null;
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
    workspaceId: workspaceId ?? "",
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
