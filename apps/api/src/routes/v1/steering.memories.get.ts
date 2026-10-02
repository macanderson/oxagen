import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMemoriesGet } from "@oxagen/oxagen/contracts/steering.memories.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Read one workspace memory with its uses and its memory PR
 * (`get_workspace_memory`, #4912). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const steeringMemoriesGetRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/memories/get
steeringMemoriesGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMemoriesGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMemoriesGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
