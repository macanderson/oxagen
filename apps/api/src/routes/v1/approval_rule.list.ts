import { Hono } from "hono";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const approvalRuleListRoute = new Hono<AppEnv>();

approvalRuleListRoute.post("/", async (c) => {
  const body = approvalRuleList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(approvalRuleList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
