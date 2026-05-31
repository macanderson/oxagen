import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveWorkspaceScope } from "@oxagen/auth";
import type { AppEnv } from "../app.js";

/**
 * Thin HTTP adapter — §7.3. Delegates workspace scope resolution to the
 * transport-agnostic resolver in @oxagen/auth and maps the typed result to
 * appropriate HTTP exceptions.
 */
export const workspaceMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-key auth pre-bound the scope — skip slug resolution.
  if (c.get("workspaceId")) return next();

  const orgId = c.get("orgId");
  if (!orgId) throw new HTTPException(400, { message: "Tenant scope missing" });

  const slug = c.req.param("workspace_slug");
  if (!slug) throw new HTTPException(400, { message: "Missing workspace slug" });

  const result = await resolveWorkspaceScope(orgId, slug);
  if (!result.ok) {
    throw new HTTPException(404, { message: "Workspace not found" });
  }
  c.set("workspaceId", result.workspaceId);
  return next();
};
