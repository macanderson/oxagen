import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workCollectorSet } from "@oxagen/oxagen/contracts/work.collector.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Create or change a GitHub work collector, or pause and resume one (`set_work_collector`, P1-03, #5103). It answers 200.
 * Mounted on the org-scoped router.
 */
export const workCollectorSetRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/collectors/set
workCollectorSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workCollectorSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workCollectorSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
