import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioDiscoveryGet } from "@oxagen/oxagen/contracts/tool.studio.discovery.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one server's discovery state. Mounted on the org-scoped router behind session auth. */
export const toolStudioDiscoveryGetRoute = new Hono<AppEnv>();

toolStudioDiscoveryGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioDiscoveryGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioDiscoveryGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
