import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentPropose } from "@oxagen/oxagen/contracts/agent.propose";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Propose a new agent as a pull request against the workspace's main repository: the definition and its generated subagent file, never a row. Mounted on the org-scoped router behind session auth. */
export const agentProposeRoute = new Hono<AppEnv>();

agentProposeRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentPropose.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentPropose.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
