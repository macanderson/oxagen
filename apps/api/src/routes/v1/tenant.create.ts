import { Hono } from "hono";
import { tenantCreate } from "@oxagen/oxagen/capabilities/tenant.create";
import { tenantCreateHandler } from "../../capabilities/tenant.create.handler.js";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const tenantCreateRoute = new Hono<AppEnv>();

tenantCreateRoute.post("/", async (c) => {
  const body = tenantCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c, { requireTenant: false });
  const out = await tenantCreateHandler(body, ctx);
  return c.json(out, 201);
});
