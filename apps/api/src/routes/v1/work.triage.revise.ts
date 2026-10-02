import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workTriageRevise } from "@oxagen/oxagen/contracts/work.triage.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Correct a work item's triage suggestion or outcome, or clear a correction (`revise_work_triage`, P1-03, #5103). It answers 200.
 * Mounted on the org-scoped router.
 */
export const workTriageReviseRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/triage/revise
workTriageReviseRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workTriageRevise.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workTriageRevise.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
