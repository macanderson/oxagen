import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { assistantAsk } from "@oxagen/oxagen/contracts/assistant.ask";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** One turn of the in-app agent, run to completion. The streaming form is /chat/stream. */
export const assistantAskRoute = new Hono<AppEnv>();

assistantAskRoute.post("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = assistantAsk.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(assistantAsk.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
