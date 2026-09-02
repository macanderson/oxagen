import { Hono } from "hono";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceSettingsWriteRoute = new Hono<AppEnv>();

workspaceSettingsWriteRoute.patch("/", async (c) => {
  const body = workspaceSettingsWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceSettingsWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
