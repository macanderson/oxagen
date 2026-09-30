import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioToolsList } from "@oxagen/oxagen/contracts/tool.studio.tools.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List one server's imported and available tools. Mounted on the org-scoped router behind session auth. */
export const toolStudioToolsListRoute = new Hono<AppEnv>();

toolStudioToolsListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioToolsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioToolsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
