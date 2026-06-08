import { Hono } from "hono";
import { userPreferencesUpdate } from "@oxagen/oxagen/contracts/user.preferences.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const userPreferencesUpdateRoute = new Hono<AppEnv>();

userPreferencesUpdateRoute.post("/", async (c) => {
  const body = userPreferencesUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(userPreferencesUpdate.name, body, ctx, { surface: "api" });
  return c.json(out);
});
