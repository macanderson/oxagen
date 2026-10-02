import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workOrderChecksRefresh } from "@oxagen/oxagen/contracts/work.order.checks.refresh";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Read again from GitHub the checks a send's pull request needs on its head
 * commit (`refresh_work_order_checks`, ADR-251).
 *
 * It answers 200. Mounted on the org-scoped router. The handler refuses an
 * API key and an agent run, so only a signed-in person decides work.
 */
export const workOrderChecksRefreshRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/orders/checks/refresh
workOrderChecksRefreshRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workOrderChecksRefresh.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workOrderChecksRefresh.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
