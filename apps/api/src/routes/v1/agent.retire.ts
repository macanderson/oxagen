import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Retire an agent identity: archive, suspend, revoke every credential and host. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const agentRetireRoute = new Hono<AppEnv>();

agentRetireRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentRetire.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentRetire.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
