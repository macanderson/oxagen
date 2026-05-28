import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../app.js";

export const workspaceMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("workspaceId")) return next();

  const tenantId = c.get("tenantId");
  if (!tenantId) throw new HTTPException(400, { message: "Tenant scope missing" });

  const slug = c.req.param("workspace_slug");
  if (!slug) throw new HTTPException(400, { message: "Missing workspace slug" });

  const d = db();
  // Composite unique index (tenant_id, slug) serves this lookup.
  const ws = await d.query.workspaces.findFirst({
    where: and(eq(schema.workspaces.tenantId, tenantId), eq(schema.workspaces.slug, slug)),
    columns: { id: true },
  });
  if (!ws) throw new HTTPException(404, { message: "Workspace not found" });
  c.set("workspaceId", ws.id);
  return next();
};
