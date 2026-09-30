import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioServerGet } from "@oxagen/oxagen/contracts/tool.studio.server.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one server folder for Studio's server page. Mounted on the org-scoped router behind session auth. */
export const toolStudioServerGetRoute = new Hono<AppEnv>();

toolStudioServerGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioServerGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioServerGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
