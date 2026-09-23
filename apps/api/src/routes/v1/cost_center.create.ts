import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costCenterCreate } from "@oxagen/oxagen/contracts/cost_center.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Add a cost-center label to the organization's list, or restore a deleted one. Mounted on the org-scoped router behind session auth. */
export const costCenterCreateRoute = new Hono<AppEnv>();

costCenterCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costCenterCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costCenterCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
