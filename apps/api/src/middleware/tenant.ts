import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../app.js";

export const tenantMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-key auth pre-bound the scope.
  if (c.get("tenantId")) return next();

  const slug = c.req.param("tenant_slug");
  if (!slug) throw new HTTPException(400, { message: "Missing tenant slug" });

  const d = db();
  const tenant = await d.query.tenants.findFirst({
    where: eq(schema.tenants.slug, slug),
    columns: { id: true },
  });
  if (!tenant) throw new HTTPException(404, { message: "Tenant not found" });

  const userId = c.get("userId");
  if (!userId) throw new HTTPException(401, { message: "Unauthenticated" });
  const membership = await d.query.tenantUsers.findFirst({
    where: and(
      eq(schema.tenantUsers.tenantId, tenant.id),
      eq(schema.tenantUsers.userId, userId),
    ),
    columns: { id: true },
  });
  if (!membership) throw new HTTPException(403, { message: "Not a member of this tenant" });

  c.set("tenantId", tenant.id);
  return next();
};
