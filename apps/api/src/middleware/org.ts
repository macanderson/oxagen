import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../app.js";

export const orgMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-key auth pre-bound the scope.
  if (c.get("orgId")) return next();

  const slug = c.req.param("org_slug");
  if (!slug) throw new HTTPException(400, { message: "Missing org slug" });

  const d = db();
  const org = await d.query.organizations.findFirst({
    where: eq(schema.organizations.slug, slug),
    columns: { id: true },
  });
  if (!org) throw new HTTPException(404, { message: "Organization not found" });

  const userId = c.get("userId");
  if (!userId) throw new HTTPException(401, { message: "Unauthenticated" });
  const membership = await d.query.orgUsers.findFirst({
    where: and(
      eq(schema.orgUsers.orgId, org.id),
      eq(schema.orgUsers.userId, userId),
    ),
    columns: { id: true },
  });
  if (!membership) throw new HTTPException(403, { message: "Not a member of this organization" });

  c.set("orgId", org.id);
  return next();
};
