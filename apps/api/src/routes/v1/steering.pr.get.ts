import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringPrGet } from "@oxagen/oxagen/contracts/steering.pr.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Get a proposal's steering PR state. Mounted on the org-scoped router behind session auth (ADR-061). */
export const steeringPrGetRoute = new Hono<AppEnv>();

steeringPrGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringPrGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringPrGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
