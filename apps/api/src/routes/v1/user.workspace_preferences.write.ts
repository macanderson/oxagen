import { Hono } from "hono";
import { userWorkspacePreferencesWrite } from "@oxagen/oxagen/contracts/user.workspace_preferences.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const userWorkspacePreferencesWriteRoute = new Hono<AppEnv>();

userWorkspacePreferencesWriteRoute.post("/", async (c) => {
  const body = userWorkspacePreferencesWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(userWorkspacePreferencesWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
