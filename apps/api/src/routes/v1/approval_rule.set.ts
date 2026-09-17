import { Hono } from "hono";
import { approvalRuleSet } from "@oxagen/oxagen/contracts/approval_rule.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const approvalRuleSetRoute = new Hono<AppEnv>();

approvalRuleSetRoute.post("/", async (c) => {
  const body = approvalRuleSet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(approvalRuleSet.name, body, ctx, { surface: "api" });
  return c.json(out);
});
