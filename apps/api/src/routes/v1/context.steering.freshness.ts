import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * The steering freshness a developer's machine checks itself against.
 * Mounted on the org-scoped router behind session auth (ADR-061).
 *
 * The `oxagen steering` commands call this in front of every prompt and
 * treat any failure as "no answer", so this route is on a latency budget and
 * must stay a plain read.
 */
export const contextSteeringFreshnessRoute = new Hono<AppEnv>();

contextSteeringFreshnessRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextSteeringFreshness.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextSteeringFreshness.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
