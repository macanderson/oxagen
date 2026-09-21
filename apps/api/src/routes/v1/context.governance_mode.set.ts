import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextGovernanceModeSet } from "@oxagen/oxagen/contracts/context.governance_mode.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Set the steering governance mode of a workspace (`set_governance_mode`).
 * Mounted on the org-scoped router, because Organization › Workspaces edits
 * from an org scope and names the target by public id; the role is checked in
 * the handler.
 *
 * 200 rather than 201: whether the change committed or opened a pull request is
 * `outcome` in the body, not the status code. A caller has to read the body
 * either way, and a status line that varied with the route would only invite
 * deciding from it.
 */
export const contextGovernanceModeSetRoute = new Hono<AppEnv>();

contextGovernanceModeSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextGovernanceModeSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextGovernanceModeSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
