import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workItemClose } from "@oxagen/oxagen/contracts/work.item.close";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Close a work item without finishing it (`close_work_item`, ADR-250).
 *
 * It answers 200. Mounted on the org-scoped router. The handler refuses an
 * API key and an agent run, so only a signed-in person decides work.
 */
export const workItemCloseRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/items/close
workItemCloseRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workItemClose.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workItemClose.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
