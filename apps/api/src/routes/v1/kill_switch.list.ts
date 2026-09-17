import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the kill switches reaching this workspace with the current deny generation. Mounted on the org-scoped router behind session auth. */
export const killSwitchListRoute = new Hono<AppEnv>();

killSwitchListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = killSwitchList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(killSwitchList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
