import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { userPreferencesSet } from "@oxagen/oxagen/contracts/user.preferences.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The Account dialog's preferences: locale, theme, timezone. User-global. */
export const userPreferencesSetRoute = new Hono<AppEnv>();

userPreferencesSetRoute.patch("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = userPreferencesSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(userPreferencesSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
