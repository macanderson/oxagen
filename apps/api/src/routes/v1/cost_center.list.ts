import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the organization's cost-center labels with how many agents and workspaces name each. Mounted on the org-scoped router behind session auth. */
export const costCenterListRoute = new Hono<AppEnv>();

costCenterListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costCenterList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costCenterList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
