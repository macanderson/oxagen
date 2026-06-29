import { Hono } from "hono";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceListRoute = new Hono<AppEnv>();

workspaceListRoute.post("/", async (c) => {
  const body = workspaceList.input.parse(await c.req.json());
  const ctx = capabilityContext(c, { requireOrg: false });
  const out = await invoke(workspaceList.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
