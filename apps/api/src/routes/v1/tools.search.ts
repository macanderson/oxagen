import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolsSearch } from "@oxagen/oxagen/contracts/tools.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The belt search and the command menu's search over the workspace's own records. */
export const toolsSearchRoute = new Hono<AppEnv>();

toolsSearchRoute.post("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = toolsSearch.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolsSearch.name, input, ctx, { surface: "api" });
  return c.json(output);
});
