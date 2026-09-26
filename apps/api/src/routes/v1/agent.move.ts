import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentMove } from "@oxagen/oxagen/contracts/agent.move";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Move an agent to another runtime and keep its principal. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const agentMoveRoute = new Hono<AppEnv>();

agentMoveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentMove.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentMove.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
