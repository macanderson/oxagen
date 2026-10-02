import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workItemsList } from "@oxagen/oxagen/contracts/work.items.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the workspace's work items with each one's state, what it waits for, its latest send, and its cost (`list_work_items`, P1-05, #5163). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const workItemsListRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/items/list
workItemsListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workItemsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workItemsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
