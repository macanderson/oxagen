import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringPrMergeWithoutReview } from "@oxagen/oxagen/contracts/steering.pr.merge_without_review";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Merge a proposal's steering PR that nobody approved, when the caller holds merge_pr_without_review. Mounted on the org-scoped router behind session auth (ADR-213). */
export const steeringPrMergeWithoutReviewRoute = new Hono<AppEnv>();

steeringPrMergeWithoutReviewRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringPrMergeWithoutReview.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringPrMergeWithoutReview.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
