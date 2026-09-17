import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type CapabilityContext, ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import { requireEnv } from "@oxagen/config/env";
import { ipInRanges } from "@oxagen/oxagen/iam";
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
 * The proxies this deployment trusts, by identity rather than by count.
 * Memoized on the same terms as the hop count above.
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
  const cidrs = trustedProxyCidrs();
  const hops = trustedProxyHops();
  const xff = c.req.header("x-forwarded-for");

  // Preferred: attribute by proxy IDENTITY. Walk from the right while each
  // entry is one of the proxies this deployment names; the first entry that is
  // not one is the furthest thing a trusted proxy vouched for, which is the
  // client. A caller can pad the left of this header all it likes — padding
  // only lengthens the untrusted prefix and can never move where the walk
  // stops, because stopping is decided by what an entry IS rather than by how
  // many entries there are.
  //
  // That is the difference from the hop count below, and it is the whole point:
  // a count trusts ITSELF to be right, and one that is too high lets a caller
  // pad until the arithmetic lands on a value the caller chose — enough to
  // satisfy an `ip_ranges` / `ip_allow` condition, or to mint a fresh
  // rate-limit bucket per request. No property of the request distinguishes
  // that from a correct deeper chain, so the count cannot defend itself and
  // only naming the proxies can.
  if (cidrs.length > 0 && xff) {
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
      // An entry is only attributable if a TRUSTED PROXY WROTE IT, which means
      // at least one trusted entry stood to its right. Without that, the
      // rightmost entry is whatever the caller sent — which is what a request
      // that never passed through a named proxy looks like, whether from a
      // typo in the CIDR list, a network change, or a path that bypasses the
      // proxy altogether. Returning it would hand the IAM allowlist and the
      // pre-auth ceilings an address the caller chose, which is the whole class
      // of bug this walk exists to close.
      return vouchedFor ? entry : null;
    }
    // Every entry is a trusted proxy, so none of them is a client. Nothing to
    // attribute — better than returning a proxy and calling it a caller.
    return null;
  }

  if (xff && hops > 0) {
    const chain = xff
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    // A chain shorter than the trusted-proxy count means a proxy did not append
    // what this deployment says it does, so NOTHING here is attributable.
    //
    // This used to clamp the index to 0 and return the leftmost entry, on the
    // reasoning that it was "the oldest thing any trusted proxy could have
    // written". That reasoning is wrong: the leftmost entry is the oldest thing
    // ANYONE could have written, and a caller writes it by sending its own
    // x-forwarded-for. So the clamp turned a misconfiguration into the exact
    // bypass this walk exists to prevent — a caller-supplied address handed to
    // the IAM ip_ranges / ip_allow conditions and to the pre-auth rate-limit
    // ceilings, refreshable per request by rotating the header. Refuse instead:
    // with a correctly declared depth the chain is never short, so this only
    // fires on a deployment whose count is wrong, and failing closed is the
    // documented direction for that.
    if (chain.length < hops) return null;
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate;
  }
  // x-real-ip is set by a single reverse proxy and carries no chain to walk.
  // It is exactly as trustworthy as that proxy, and no more — so with no
  // trusted proxy it is worth nothing. This fallback used to run regardless of
  // the hop count, which contradicted the rule three paragraphs up: at
  // TRUSTED_PROXY_HOP_COUNT = 0 the x-forwarded-for chain was correctly
  // ignored as caller-supplied while x-real-ip, equally caller-supplied on a
  // direct deployment, was still believed. A caller could then hand this
  // function any address it liked — satisfying an `ip_ranges` / `ip_allow`
  // condition it should fail, and minting itself a fresh rate-limit bucket per
  // request by rotating the header.
  if (hops === 0) return null;
  const realIp = c.req.header("x-real-ip");
  return realIp?.trim() || null;
}

/** Test seam: drop the memoized hop count so a case can set a different env. */
export function __resetTrustedProxyHopsForTests(): void {
  cachedTrustedProxyHops = null;
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
