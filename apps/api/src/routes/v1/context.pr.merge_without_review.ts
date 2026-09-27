import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextPrMergeWithoutReview } from "@oxagen/oxagen/contracts/context.pr.merge_without_review";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Merge a proposal's Context PR that nobody approved, when the caller holds merge_pr_without_review. Mounted on the org-scoped router behind session auth (ADR-213). */
export const contextPrMergeWithoutReviewRoute = new Hono<AppEnv>();

contextPrMergeWithoutReviewRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextPrMergeWithoutReview.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextPrMergeWithoutReview.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
