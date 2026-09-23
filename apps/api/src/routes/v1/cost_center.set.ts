import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costCenterSet } from "@oxagen/oxagen/contracts/cost_center.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Charge the active workspace, or one of its agents, back to a cost-center label, or clear it. Mounted on the org-scoped router behind session auth. */
export const costCenterSetRoute = new Hono<AppEnv>();

costCenterSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costCenterSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costCenterSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
