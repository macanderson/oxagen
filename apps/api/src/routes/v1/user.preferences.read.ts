import { Hono } from "hono";
import { userPreferencesRead } from "@oxagen/oxagen/contracts/user.preferences.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const userPreferencesReadRoute = new Hono<AppEnv>();

userPreferencesReadRoute.get("/", async (c) => {
  const input = userPreferencesRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(userPreferencesRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
