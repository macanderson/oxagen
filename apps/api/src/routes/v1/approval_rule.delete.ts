import { Hono } from "hono";
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const approvalRuleDeleteRoute = new Hono<AppEnv>();

approvalRuleDeleteRoute.post("/", async (c) => {
  const body = approvalRuleDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(approvalRuleDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
