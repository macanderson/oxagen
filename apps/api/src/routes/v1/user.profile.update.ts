import { Hono } from "hono";
import { userProfileUpdate } from "@oxagen/oxagen/contracts/user.profile.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The Account dialog's identity fields: display name and avatar. User-global. */
export const userProfileUpdateRoute = new Hono<AppEnv>();

userProfileUpdateRoute.patch("/", async (c) => {
  const input = userProfileUpdate.input.parse(await c.req.json());
  // Mounted on the unscoped `userScoped` router, where authMiddleware sets
  // only userId: there is no org or workspace in the context and the
  // capability is `scoped: false` because a person's identity is global, same
  // as `user.preferences.set`. Requiring an org here (the default) would 400
  // for a session user who does not belong to an organization yet.
  const ctx = capabilityContext(c, { requireOrg: false });
  const output = await invoke(userProfileUpdate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
