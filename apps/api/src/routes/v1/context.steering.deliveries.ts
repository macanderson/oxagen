import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextSteeringDeliveries } from "@oxagen/oxagen/contracts/context.steering.deliveries";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const contextSteeringDeliveriesRoute = new Hono<AppEnv>();

contextSteeringDeliveriesRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextSteeringDeliveries.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextSteeringDeliveries.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
