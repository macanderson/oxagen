import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMemoriesDismiss } from "@oxagen/oxagen/contracts/steering.memories.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Dismiss workspace memories, or restore them with `restore: true`
 * (`dismiss_memories`, #4912). It answers 200. Mounted on the org-scoped
 * router.
 */
export const steeringMemoriesDismissRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/memories/dismiss
steeringMemoriesDismissRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMemoriesDismiss.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMemoriesDismiss.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
