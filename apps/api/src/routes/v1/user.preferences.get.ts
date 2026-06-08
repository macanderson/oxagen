import { Hono } from "hono";
import { userPreferencesGet } from "@oxagen/oxagen/contracts/user.preferences.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const userPreferencesGetRoute = new Hono<AppEnv>();

userPreferencesGetRoute.get("/", async (c) => {
  const input = userPreferencesGet.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(userPreferencesGet.name, input, ctx, { surface: "api" });
  return c.json(out);
});
