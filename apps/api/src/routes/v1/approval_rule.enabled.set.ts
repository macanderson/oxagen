import { Hono } from "hono";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const approvalRuleEnabledSetRoute = new Hono<AppEnv>();

approvalRuleEnabledSetRoute.post("/", async (c) => {
  const body = approvalRuleEnabledSet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(approvalRuleEnabledSet.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
