import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentCacheKeepAliveSet } from "@oxagen/oxagen/contracts/agent.cache_keep_alive.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Turn the cache keep-alive on or off for one agent in the active workspace. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const agentCacheKeepAliveSetRoute = new Hono<AppEnv>();

agentCacheKeepAliveSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentCacheKeepAliveSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentCacheKeepAliveSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
