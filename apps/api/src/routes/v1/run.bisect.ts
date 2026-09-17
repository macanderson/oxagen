import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runBisect } from "@oxagen/oxagen/contracts/run.bisect";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Align two runs and answer the first divergent frame. Mounted on the org-scoped router behind session auth. */
export const runBisectRoute = new Hono<AppEnv>();

runBisectRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runBisect.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runBisect.name, input, ctx, { surface: "api" });
  return c.json(output);
});
