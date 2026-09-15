import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentDefinitionCommit } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Commit an agent's definition file to a branch and open the pull request. The handler checks the org role and refuses the default branch. Mounted on the org-scoped router behind session auth. */
export const agentDefinitionCommitRoute = new Hono<AppEnv>();

agentDefinitionCommitRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentDefinitionCommit.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentDefinitionCommit.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
