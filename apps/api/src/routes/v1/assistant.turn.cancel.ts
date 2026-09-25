import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { assistantTurnCancel } from "@oxagen/oxagen/contracts/assistant.turn.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Stop the caller's own running turn of the in-app agent by the `turnId` the
 * caller gave /assistant/ask (#4164). A stop for a turn that already ended
 * answers `found: false`, not an error.
 */
export const assistantTurnCancelRoute = new Hono<AppEnv>();

assistantTurnCancelRoute.post("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = assistantTurnCancel.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(assistantTurnCancel.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
