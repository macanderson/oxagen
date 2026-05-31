import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveOrgScope } from "@oxagen/auth";
import type { OrgScopeResolutionError } from "@oxagen/auth";
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
  if (result.ok) {
    c.set("orgId", result.orgId);
    return next();
  }

  // The @vercel/hono builder drops discriminated-union narrowing across the
  // success early-return above, so read the error kind via an explicit cast
  // (same pattern as the apiKey middleware fix). result is necessarily the
  // ok:false branch here.
  const { kind } = result as OrgScopeResolutionError;
  switch (kind) {
    case "not_found":
      throw new HTTPException(404, { message: "Organization not found" });
    case "not_member":
      throw new HTTPException(403, { message: "Not a member of this organization" });
    default:
      // Exhaustiveness guard: a new OrgScopeResolutionError kind fails to
      // compile here, and at runtime throws 500 rather than silently calling
      // next() with orgId unset (which would slip past the membership gate).
      return assertNever(kind);
  }
};

function assertNever(value: never): never {
  throw new HTTPException(500, {
    message: `Unhandled org scope resolution error: ${JSON.stringify(value)}`,
  });
}
