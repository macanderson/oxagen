import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextSteeringLayout } from "@oxagen/oxagen/contracts/context.steering.layout";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Which layout the workspace's bound repository uses, steering or legacy
 * (#4765). Mounted on the org-scoped router behind session auth (ADR-061).
 *
 * A client reads it to preview the path and branch `open_steering_pr` will
 * write, so it stays a plain read with no per-route logic.
 */
export const contextSteeringLayoutRoute = new Hono<AppEnv>();

contextSteeringLayoutRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextSteeringLayout.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextSteeringLayout.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
