import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one run's cost rollup. Mounted on the org-scoped router behind session auth. */
export const runCostGetRoute = new Hono<AppEnv>();

runCostGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runCostGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runCostGet.name, input, ctx, { surface: "api" });
  return c.json(output);
});
