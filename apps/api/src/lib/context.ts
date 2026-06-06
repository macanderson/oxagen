import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { AppEnv } from "../app";

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
  };
}
