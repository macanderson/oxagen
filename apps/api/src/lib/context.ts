import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { AppEnv } from "../app.js";

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
    requestId: c.get("requestId") ?? "",
    surface: "api",
    messageId: null,
  };
}
