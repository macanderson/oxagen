import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { assistantEngineGet } from "@oxagen/oxagen/contracts/assistant.engine.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The in-app agent's engine probe. Mounted on the org-scoped router behind session auth. */
export const assistantEngineGetRoute = new Hono<AppEnv>();

assistantEngineGetRoute.get("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = assistantEngineGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(assistantEngineGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
