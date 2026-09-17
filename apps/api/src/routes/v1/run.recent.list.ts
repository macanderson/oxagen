import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runRecentList } from "@oxagen/oxagen/contracts/run.recent.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The command menu's Runs group: the newest runs of the workspace. */
export const runRecentListRoute = new Hono<AppEnv>();

runRecentListRoute.post("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = runRecentList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runRecentList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
