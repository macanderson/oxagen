import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Queue a control command for a Tacho host or session. Mounted on the org-scoped router behind session auth. */
export const tachoCommandDispatchRoute = new Hono<AppEnv>();

tachoCommandDispatchRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoCommandDispatch.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoCommandDispatch.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
