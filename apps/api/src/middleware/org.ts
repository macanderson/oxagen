import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveOrgScope } from "@oxagen/auth";
import type { AppEnv } from "../app.js";

/**
 * Thin HTTP adapter — §7.3. Delegates org scope resolution to the
 * transport-agnostic resolver in @oxagen/auth and maps the typed result to
 * appropriate HTTP exceptions.
 */
export const orgMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-key auth pre-bound the scope — skip slug resolution.
  if (c.get("orgId")) return next();

  const slug = c.req.param("org_slug");
  if (!slug) throw new HTTPException(400, { message: "Missing org slug" });

  const userId = c.get("userId");
  if (!userId) throw new HTTPException(401, { message: "Unauthenticated" });

  const result = await resolveOrgScope(userId, slug);
  if (!result.ok) {
    if (result.kind === "not_found") throw new HTTPException(404, { message: "Organization not found" });
    if (result.kind === "not_member") throw new HTTPException(403, { message: "Not a member of this organization" });
  } else {
    c.set("orgId", result.orgId);
  }

  return next();
};
