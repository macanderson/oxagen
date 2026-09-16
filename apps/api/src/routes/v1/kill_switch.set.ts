import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { killSwitchSet } from "@oxagen/oxagen/contracts/kill_switch.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Flip a kill switch on or off. Mounted on the org-scoped router behind session auth. */
export const killSwitchSetRoute = new Hono<AppEnv>();

killSwitchSetRoute.put("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = killSwitchSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(killSwitchSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
