import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringPrApprove } from "@oxagen/oxagen/contracts/steering.pr.approve";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Approve a proposal's steering PR at its head (`approve_steering_pr`,
 * #4518, ADR-267). The approver is the signed-in person, so an API key is
 * refused. Mounted on the org-scoped router.
 */
export const steeringPrApproveRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/steering/prs/approve
steeringPrApproveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringPrApprove.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringPrApprove.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
