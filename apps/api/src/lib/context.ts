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

export function capabilityContext(
  c: Context<AppEnv>,
  options: { requireOrg?: boolean } = {},
): CapabilityContext {
  const orgId = c.get("orgId");
  const workspaceId = c.get("workspaceId");
  if (options.requireOrg !== false) {
    if (!orgId || !workspaceId) {
      throw new HTTPException(400, { message: "Org/workspace scope required" });
    }
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
