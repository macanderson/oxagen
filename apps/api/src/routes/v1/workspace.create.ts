import { Hono } from "hono";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { workspaceCreateHandler } from "@oxagen/handlers/workspace.create";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const workspaceCreateRoute = new Hono<AppEnv>();

workspaceCreateRoute.post("/", async (c) => {
  const body = workspaceCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await workspaceCreateHandler(body, ctx);
  return c.json(out, 201);
});
