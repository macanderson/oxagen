import { Hono } from "hono";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceCreateRoute = new Hono<AppEnv>();

workspaceCreateRoute.post("/", async (c) => {
  const body = workspaceCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceCreate.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});
