import { Hono } from "hono";
import { skillWorkspaceList } from "@oxagen/oxagen/contracts/skill.workspace.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillWorkspaceListRoute = new Hono<AppEnv>();

skillWorkspaceListRoute.get("/", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  const input = skillWorkspaceList.input.parse({ workspace_id });
  const ctx = capabilityContext(c);
  const out = await invoke(skillWorkspaceList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
