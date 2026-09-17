import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolsLoad } from "@oxagen/oxagen/contracts/tools.load";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The full definitions of capabilities the in-app agent may call, by name. */
export const toolsLoadRoute = new Hono<AppEnv>();

toolsLoadRoute.post("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = toolsLoad.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolsLoad.name, input, ctx, { surface: "api" });
  return c.json(output);
});
