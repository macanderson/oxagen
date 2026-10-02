import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Count what the workspace's work finished in a window of days (`get_work_outcomes`, P1-05, #5163). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const workOutcomesGetRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/outcomes/get
workOutcomesGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workOutcomesGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workOutcomesGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
