import { Hono } from "hono";
import { workspaceSettingsRead } from "@oxagen/oxagen/contracts/workspace.settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceSettingsReadRoute = new Hono<AppEnv>();

workspaceSettingsReadRoute.get("/", async (c) => {
  const input = workspaceSettingsRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceSettingsRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
