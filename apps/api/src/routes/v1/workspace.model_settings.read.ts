import { Hono } from "hono";
import { workspaceModelSettingsRead } from "@oxagen/oxagen/contracts/workspace.model_settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceModelSettingsReadRoute = new Hono<AppEnv>();

workspaceModelSettingsReadRoute.get("/", async (c) => {
  const input = workspaceModelSettingsRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceModelSettingsRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
