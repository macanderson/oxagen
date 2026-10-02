import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMemoriesPromote } from "@oxagen/oxagen/contracts/steering.memories.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Promote waiting memories into draft steering records on the open memory
 * PR, or open one (`promote_memories`, #4912). It answers 200 whether the
 * drafts joined a PR or opened one, and the body says which. Mounted on the
 * org-scoped router.
 */
export const steeringMemoriesPromoteRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/memories/promote
steeringMemoriesPromoteRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMemoriesPromote.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMemoriesPromote.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
