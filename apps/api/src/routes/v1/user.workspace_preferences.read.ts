import { Hono } from "hono";
import { userWorkspacePreferencesRead } from "@oxagen/oxagen/contracts/user.workspace_preferences.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const userWorkspacePreferencesReadRoute = new Hono<AppEnv>();

userWorkspacePreferencesReadRoute.get("/", async (c) => {
  const input = userWorkspacePreferencesRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(userWorkspacePreferencesRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
