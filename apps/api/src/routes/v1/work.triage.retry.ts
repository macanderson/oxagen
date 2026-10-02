import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workTriageRetry } from "@oxagen/oxagen/contracts/work.triage.retry";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Queue triage to run again on a work item (`retry_work_triage`, P1-03, #5103). It answers 202.
 * Mounted on the org-scoped router.
 */
export const workTriageRetryRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/triage/retry
workTriageRetryRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workTriageRetry.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workTriageRetry.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 202);
});
