import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workOrderCancel } from "@oxagen/oxagen/contracts/work.order.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Withdraw a send no runtime has claimed (`cancel_work_order`, ADR-250).
 *
 * It answers 200. Mounted on the org-scoped router. The handler refuses an
 * API key and an agent run, so only a signed-in person decides work.
 */
export const workOrderCancelRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/orders/cancel
workOrderCancelRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workOrderCancel.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workOrderCancel.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
