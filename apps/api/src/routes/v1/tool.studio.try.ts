import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioTry } from "@oxagen/oxagen/contracts/tool.studio.try";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Send one call to one Studio tool against one environment. Mounted on the org-scoped router behind session auth. */
export const toolStudioTryRoute = new Hono<AppEnv>();

toolStudioTryRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioTry.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioTry.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
