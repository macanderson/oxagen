import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { AppEnv } from "../app.js";

export function capabilityContext(
  c: Context<AppEnv>,
  options: { requireTenant?: boolean } = {},
): CapabilityContext {
  const tenantId = c.get("tenantId");
  const workspaceId = c.get("workspaceId");
  if (options.requireTenant !== false) {
    if (!tenantId || !workspaceId) {
      throw new HTTPException(400, { message: "Tenant/workspace scope required" });
    }
  }
  return {
    tenantId: tenantId ?? "",
    workspaceId: workspaceId ?? "",
    userId: c.get("userId") ?? null,
    apiKeyId: c.get("apiKeyId") ?? null,
    requestId: c.get("requestId") ?? "",
  };
}
