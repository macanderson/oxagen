import { Hono } from "hono";
import { skillWorkspaceInstall } from "@oxagen/oxagen/contracts/skill.workspace.install";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillWorkspaceInstallRoute = new Hono<AppEnv>();

skillWorkspaceInstallRoute.post("/", async (c) => {
  const input = skillWorkspaceInstall.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillWorkspaceInstall.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
