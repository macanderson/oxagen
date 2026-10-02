import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMemoriesList } from "@oxagen/oxagen/contracts/steering.memories.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the workspace's memories ranked by uses, with same-text memories
 * grouped (`list_workspace_memories`, #4912). Writes nothing, so it answers
 * 200. Mounted on the org-scoped router.
 */
export const steeringMemoriesListRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/memories/list
steeringMemoriesListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMemoriesList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMemoriesList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
