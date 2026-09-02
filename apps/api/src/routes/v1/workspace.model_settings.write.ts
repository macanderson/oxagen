import { Hono } from "hono";
import { workspaceModelSettingsWrite } from "@oxagen/oxagen/contracts/workspace.model_settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceModelSettingsWriteRoute = new Hono<AppEnv>();

workspaceModelSettingsWriteRoute.patch("/", async (c) => {
  const body = workspaceModelSettingsWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceModelSettingsWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
