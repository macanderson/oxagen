import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costCenterDelete } from "@oxagen/oxagen/contracts/cost_center.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Delete a cost-center label from the organization's list. Mounted on the org-scoped router behind session auth. */
export const costCenterDeleteRoute = new Hono<AppEnv>();

costCenterDeleteRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costCenterDelete.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costCenterDelete.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
