import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runChainGet } from "@oxagen/oxagen/contracts/run.chain.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read what makes one run's record tamper-evident. Mounted on the org-scoped router behind session auth. */
export const runChainGetRoute = new Hono<AppEnv>();

runChainGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runChainGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runChainGet.name, input, ctx, { surface: "api" });
  return c.json(output);
});
