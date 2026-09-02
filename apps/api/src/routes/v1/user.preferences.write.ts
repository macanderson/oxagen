import { Hono } from "hono";
import { userPreferencesWrite } from "@oxagen/oxagen/contracts/user.preferences.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const userPreferencesWriteRoute = new Hono<AppEnv>();

userPreferencesWriteRoute.patch("/", async (c) => {
  const body = userPreferencesWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(userPreferencesWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
