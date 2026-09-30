import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioListingStart } from "@oxagen/oxagen/contracts/tool.studio.listing.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Ask a machine to list a Studio draft's tools. Mounted on the org-scoped router behind session auth. */
export const toolStudioListingStartRoute = new Hono<AppEnv>();

toolStudioListingStartRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioListingStart.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioListingStart.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
