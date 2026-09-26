import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolbeltList } from "@oxagen/oxagen/contracts/toolbelt.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the workspace's toolbelts, All tools first, with their counts. Mounted on the org-scoped router behind session auth. */
export const toolbeltListRoute = new Hono<AppEnv>();

toolbeltListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolbeltList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolbeltList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
