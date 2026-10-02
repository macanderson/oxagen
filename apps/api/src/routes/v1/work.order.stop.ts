import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workOrderStop } from "@oxagen/oxagen/contracts/work.order.stop";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Ask the runtime to stop the run a send started (`stop_work_order`,
 * ADR-250).
 *
 * It answers 200. Mounted on the org-scoped router. The handler refuses an
 * API key and an agent run, so only a signed-in person decides work.
 */
export const workOrderStopRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/orders/stop
workOrderStopRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workOrderStop.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workOrderStop.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
