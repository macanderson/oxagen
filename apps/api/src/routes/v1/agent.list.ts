import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the workspace's agent identities with their counts and 30-day figures. Mounted on the org-scoped router behind session auth. */
export const agentListRoute = new Hono<AppEnv>();

agentListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
