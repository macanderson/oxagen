import { Hono } from "hono";
import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { organizationCreateHandler } from "@oxagen/handlers/organization.create";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const organizationCreateRoute = new Hono<AppEnv>();

organizationCreateRoute.post("/", async (c) => {
  const body = organizationCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c, { requireTenant: false });
  const out = await organizationCreateHandler(body, ctx);
  return c.json(out, 201);
});
