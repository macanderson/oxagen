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
  // Mounted on the unscoped `userScoped` router, where authMiddleware sets
  // only userId: there is no org or workspace in the context and the
  // capability is `scoped: false` because it is user-global. Requiring an org
  // here (the default) threw "Org scope required" before the handler could
  // run, so this returned 400 for every session user — including a new user
  // who does not belong to an organization yet.
  const ctx = capabilityContext(c, { requireOrg: false });
  const output = await invoke(userPreferencesSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
