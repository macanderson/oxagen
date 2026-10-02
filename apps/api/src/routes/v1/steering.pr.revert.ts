import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringPrRevert } from "@oxagen/oxagen/contracts/steering.pr.revert";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Open a steering PR that undoes a merged one. Mounted on the org-scoped router (#4449). */
export const steeringPrRevertRoute = new Hono<AppEnv>();

steeringPrRevertRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringPrRevert.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringPrRevert.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
