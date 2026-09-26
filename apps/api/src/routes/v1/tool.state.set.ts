import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStateSet } from "@oxagen/oxagen/contracts/tool.state.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Make tools available to toolbelts or take them out, and set whether each starts active. The handler checks the role. Mounted on the org-scoped router behind session auth. */
export const toolStateSetRoute = new Hono<AppEnv>();

toolStateSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStateSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStateSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
