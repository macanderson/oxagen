import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringPrRefresh } from "@oxagen/oxagen/contracts/steering.pr.refresh";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read a proposal's steering PR from the host now and move the proposal to the host's state. Mounted on the org-scoped router behind session auth (ADR-184). */
export const steeringPrRefreshRoute = new Hono<AppEnv>();

steeringPrRefreshRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringPrRefresh.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringPrRefresh.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
