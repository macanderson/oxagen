import { Hono } from "hono";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const budgetPolicyReadRoute = new Hono<AppEnv>();

budgetPolicyReadRoute.get("/", async (c) => {
  const input = budgetPolicyRead.input.parse({});
  // Mounted on the unscoped `userScoped` router, where authMiddleware sets
  // only userId: there is no org or workspace in the context and the
  // capability is `scoped: false` because it is user-global. Requiring an org
  // here (the default) threw "Org scope required" before the handler could
  // run, so this returned 400 for every session user — including a new user
  // who does not belong to an organization yet.
  const ctx = capabilityContext(c, { requireOrg: false });
  const out = await invoke(budgetPolicyRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
