import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringPrOpen } from "@oxagen/oxagen/contracts/steering.pr.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Open a proposal's steering PR and run its checks. Mounted on the org-scoped router behind session auth (ADR-061). */
export const steeringPrOpenRoute = new Hono<AppEnv>();

steeringPrOpenRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringPrOpen.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringPrOpen.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
