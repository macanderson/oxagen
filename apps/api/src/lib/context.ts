import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type CapabilityContext, ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import { requireEnv } from "@oxagen/config/env";
import { ipInRanges } from "@oxagen/oxagen/iam";
import type { AppEnv } from "../app";

/**
 * The proxies this deployment trusts, named by CIDR. Resolved from the
 * validated env once and memoized — read on the first request rather than at
 * module load, so importing the app never triggers env access, mirroring
 * `rateLimitBudgets()` in middleware/distributed-rate-limit.ts.
 */
let cachedTrustedProxyCidrs: string[] | null = null;
export function trustedProxyCidrs(): string[] {
  if (cachedTrustedProxyCidrs !== null) return cachedTrustedProxyCidrs;
  const env = requireEnv(["TRUSTED_PROXY_CIDRS"] as const);
  cachedTrustedProxyCidrs = env.TRUSTED_PROXY_CIDRS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return cachedTrustedProxyCidrs;
}

/**
 * The client address, when — and only when — a proxy this deployment names
 * vouched for it. `null` otherwise, and `null` means "do not decide anything
 * with this".
 *
 * Two things read it and both are security decisions: the IAM `ip_ranges` /
 * `ip_allow` conditions (via `clientIp` on the capability context) and the
 * pre-authentication rate-limit ceilings. Neither can tell a real client
 * address from a plausible-looking one, so this function must not hand them
 * anything it cannot stand behind.
 *
 * HOW: walk `x-forwarded-for` from the right while each entry is one of the
 * proxies named in TRUSTED_PROXY_CIDRS, and stop at the first entry that is
 * not. That entry is the furthest address a trusted proxy vouched for — the
 * client. A caller can pad the left of the header all it likes; padding only
 * lengthens a prefix the walk never reaches, because stopping is decided by
 * what an entry IS rather than by how many entries there are.
 *
 * WHY NOT A HOP COUNT: counting hops was the previous design and it is gone,
 * not deprecated. A count trusts ITSELF to be right, while the caller controls
 * the header's LENGTH — so a count too high by k lets a caller pad k entries
 * until the arithmetic lands on a value it chose, which is enough to satisfy an
 * IP allowlist it should fail. Nothing in the request distinguishes that from a
 * correct deeper chain, so no amount of care at the call site can rescue it,
 * and a fallback that silently produces an unvouched-for address is worse than
 * no address at all: it turns "this deployment cannot attribute callers" into
 * "this allowlist is enforced", which is a lie an operator acts on.
 *
 * `x-real-ip` is not consulted. It carries no chain, so nothing can vouch for
 * it; it is exactly as caller-supplied as anything else when no proxy is named.
 *
 * Returning null is the SAFE direction for both readers. The IAM conditions
 * already fail closed on a null address, and the rate-limit ceilings skip
 * rather than pooling every caller into one bucket.
 */
export function extractClientIp(c: Context<AppEnv>): string | null {
  const cidrs = trustedProxyCidrs();
  if (cidrs.length === 0) return null;

  const xff = c.req.header("x-forwarded-for");
  if (!xff) return null;

  const chain = xff
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);

  let vouchedFor = false;
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i] as string;
    if (ipInRanges(entry, cidrs)) {
      vouchedFor = true;
      continue;
    }
    // Attributable only if a TRUSTED PROXY WROTE IT, which means at least one
    // trusted entry stood to its right. Without that, the rightmost entry is
    // whatever the caller sent — what a request that never passed through a
    // named proxy looks like, whether from a typo in the CIDR list, a network
    // change, or a path that bypasses the proxy altogether.
    return vouchedFor ? entry : null;
  }
  // Every entry is a trusted proxy, so none of them is a client.
  return null;
}

/** Test seam: drop the memoized proxy list so a case can set a different env. */
export function __resetTrustedProxyHopsForTests(): void {
  cachedTrustedProxyCidrs = null;
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
