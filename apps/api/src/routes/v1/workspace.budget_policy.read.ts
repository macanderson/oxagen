import { Hono } from "hono";
import { workspaceBudgetPolicyRead } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceBudgetPolicyReadRoute = new Hono<AppEnv>();

workspaceBudgetPolicyReadRoute.get("/", async (c) => {
  const input = workspaceBudgetPolicyRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceBudgetPolicyRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
