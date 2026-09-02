import { Hono } from "hono";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const organizationCreateRoute = new Hono<AppEnv>();

organizationCreateRoute.post("/", async (c) => {
  const body = organizationCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c, { requireOrg: false });
  const out = await invoke(organizationCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
