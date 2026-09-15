import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Suspend or resume an agent identity. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const agentSuspendRoute = new Hono<AppEnv>();

agentSuspendRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentSuspend.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentSuspend.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
