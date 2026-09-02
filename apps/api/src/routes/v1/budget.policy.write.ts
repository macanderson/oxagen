import { Hono } from "hono";
import { budgetPolicyWrite } from "@oxagen/oxagen/contracts/budget.policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const budgetPolicyWriteRoute = new Hono<AppEnv>();

budgetPolicyWriteRoute.patch("/", async (c) => {
  const body = budgetPolicyWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(budgetPolicyWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
