import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentToolbeltGet } from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Compute the belt an agent would be shown, with the decision and rule per tool. Mounted on the org-scoped router behind session auth. */
export const agentToolbeltGetRoute = new Hono<AppEnv>();

agentToolbeltGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentToolbeltGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentToolbeltGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
