import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioSelectionRun } from "@oxagen/oxagen/contracts/tool.studio.selection.run";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Run one Studio server's selection tests against the workspace's model. Mounted on the org-scoped router behind session auth. */
export const toolStudioSelectionRunRoute = new Hono<AppEnv>();

toolStudioSelectionRunRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioSelectionRun.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioSelectionRun.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
