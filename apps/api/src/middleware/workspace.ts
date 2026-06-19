import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveWorkspaceScope } from "@oxagen/auth";
import type { AppEnv } from "../app";

/**
 * Thin HTTP adapter — §7.3. Delegates workspace scope resolution to the
 * transport-agnostic resolver in @oxagen/auth and maps the typed result to
 * appropriate HTTP exceptions.
 *
 * Workspace isolation: when the request is session-authenticated (userId is
 * set by authMiddleware), the resolver also verifies workspace membership.
 * This prevents a user from one workspace accessing another workspace's
 * resources within the same org, independent of IAM enforcement state.
 * API-key requests already carry a pre-bound workspaceId and skip this path.
 */
export const workspaceMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-key auth pre-bound the scope — skip slug resolution.
  if (c.get("workspaceId")) return next();

  const orgId = c.get("orgId");
  if (!orgId) throw new HTTPException(400, { message: "Tenant scope missing" });

  const slug = c.req.param("workspace_slug");
  if (!slug) throw new HTTPException(400, { message: "Missing workspace slug" });

  // Pass userId so the resolver enforces workspace membership. A null/absent
  // userId (shouldn't occur here — authMiddleware runs first) degrades
  // gracefully to a slug-only lookup (no membership check).
  const userId = c.get("userId");
  const result = await resolveWorkspaceScope(orgId, slug, userId);
  if (!result.ok) {
    if (result.kind === "not_member") {
      // Return 403 Forbidden: the workspace exists but the user is not a member.
      // Do NOT return 404 here — that would expose that the workspace slug is
      // valid in the org (slug-existence enumeration). 403 is sufficient: it
      // denies access without revealing whether the workspace exists.
      throw new HTTPException(403, { message: "Forbidden" });
    }
    throw new HTTPException(404, { message: "Workspace not found" });
  }
  c.set("workspaceId", result.workspaceId);
  return next();
};
