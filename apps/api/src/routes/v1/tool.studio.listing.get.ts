import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioListingGet } from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read a Studio draft's tool listing. Mounted on the org-scoped router behind session auth. */
export const toolStudioListingGetRoute = new Hono<AppEnv>();

toolStudioListingGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioListingGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioListingGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
