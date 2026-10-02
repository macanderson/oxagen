import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workPrioritiesGet } from "@oxagen/oxagen/contracts/work.priorities.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Read the priorities record triage ranks by (`get_work_priorities`, P1-03, #5103). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const workPrioritiesGetRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/priorities/get
workPrioritiesGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workPrioritiesGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workPrioritiesGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
