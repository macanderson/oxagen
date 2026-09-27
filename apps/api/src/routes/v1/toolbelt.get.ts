import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolbeltGet } from "@oxagen/oxagen/contracts/toolbelt.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one toolbelt with the workspace's tools grouped by server. Mounted on the org-scoped router behind session auth. */
export const toolbeltGetRoute = new Hono<AppEnv>();

toolbeltGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolbeltGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolbeltGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
