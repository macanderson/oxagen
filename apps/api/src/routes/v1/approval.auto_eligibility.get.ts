import { Hono } from "hono";
import { approvalAutoEligibilityGet } from "@oxagen/oxagen/contracts/approval.auto_eligibility.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const approvalAutoEligibilityGetRoute = new Hono<AppEnv>();

approvalAutoEligibilityGetRoute.post("/", async (c) => {
  const body = approvalAutoEligibilityGet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(approvalAutoEligibilityGet.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
