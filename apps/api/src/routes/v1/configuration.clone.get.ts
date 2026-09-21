import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { configurationCloneGet } from "@oxagen/oxagen/contracts/configuration.clone.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** get_clone_draft on the org-scoped router behind session auth. */
export const configurationCloneGetRoute = new Hono<AppEnv>();

configurationCloneGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = configurationCloneGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(configurationCloneGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
