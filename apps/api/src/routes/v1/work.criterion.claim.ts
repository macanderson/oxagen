import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workCriterionClaim } from "@oxagen/oxagen/contracts/work.criterion.claim";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Claim, as the agent working a send, that one criterion of the brief is met
 * on the pull request's head commit (`claim_work_criterion`, ADR-244,
 * ADR-251).
 *
 * It answers 200. Mounted on the org-scoped router. The handler takes only the
 * run linked to the send, or the key of the host that claimed the send, and
 * refuses a person and any other key. A claim moves nothing: a person still
 * decides.
 */
export const workCriterionClaimRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/orders/criteria/claim
workCriterionClaimRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workCriterionClaim.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workCriterionClaim.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
