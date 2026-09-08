import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { AppEnv } from "../app";

/**
 * Extract the real client IP from standard proxy headers.
 * x-forwarded-for may carry a comma-separated list of IPs when requests pass
 * through multiple proxies; take only the first hop (leftmost = original client).
 * Falls back to x-real-ip, then null when neither header is present.
 *
 * SECURITY: these headers can be spoofed. They are used only for IAM
 * ip_ranges/ip_allow condition evaluation, never for authentication.
 */
function extractClientIp(c: Context<AppEnv>): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const realIp = c.req.header("x-real-ip");
  return realIp?.trim() || null;
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
