import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workOrderAccept } from "@oxagen/oxagen/contracts/work.order.accept";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Accept a send's result on the pull request's head commit
 * (`accept_work_order`, ADR-251).
 *
 * It answers 200. Mounted on the org-scoped router. The handler refuses an
 * API key and an agent run, so only a signed-in person decides work.
 */
export const workOrderAcceptRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/orders/accept
workOrderAcceptRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workOrderAccept.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workOrderAccept.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
