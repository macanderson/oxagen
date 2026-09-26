import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentToolbeltAssign } from "@oxagen/oxagen/contracts/agent.toolbelt.assign";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Give an agent another toolbelt and keep its principal. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const agentToolbeltAssignRoute = new Hono<AppEnv>();

agentToolbeltAssignRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentToolbeltAssign.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentToolbeltAssign.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
