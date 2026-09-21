import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { configurationClonePropose } from "@oxagen/oxagen/contracts/configuration.clone.propose";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** propose_configuration_clone on the org-scoped router behind session auth. */
export const configurationCloneProposeRoute = new Hono<AppEnv>();

configurationCloneProposeRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = configurationClonePropose.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(configurationClonePropose.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
