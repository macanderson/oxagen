import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioDiscoveryStart } from "@oxagen/oxagen/contracts/tool.studio.discovery.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Queue a discovery of one server's tools now. Mounted on the org-scoped router behind session auth. */
export const toolStudioDiscoveryStartRoute = new Hono<AppEnv>();

toolStudioDiscoveryStartRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioDiscoveryStart.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioDiscoveryStart.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
