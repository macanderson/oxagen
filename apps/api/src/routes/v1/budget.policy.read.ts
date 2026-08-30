import { Hono } from "hono";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const budgetPolicyReadRoute = new Hono<AppEnv>();

budgetPolicyReadRoute.get("/", async (c) => {
  const input = budgetPolicyRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(budgetPolicyRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
