import { Hono } from "hono";
import { workspaceBudgetPolicyWrite } from "@oxagen/oxagen/contracts/workspace.budget_policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceBudgetPolicyWriteRoute = new Hono<AppEnv>();

workspaceBudgetPolicyWriteRoute.patch("/", async (c) => {
  const body = workspaceBudgetPolicyWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceBudgetPolicyWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
