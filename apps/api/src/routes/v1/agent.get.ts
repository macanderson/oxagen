import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one agent identity with its credentials, roles, hosts and definition of record. Mounted on the org-scoped router behind session auth. */
export const agentGetRoute = new Hono<AppEnv>();

agentGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
