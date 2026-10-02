import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workItemGet } from "@oxagen/oxagen/contracts/work.item.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Read one work item by its number or its public id, with its triage, briefs, sends, checks, and history (`get_work_item`, P1-05, #5163). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const workItemGetRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/items/get
workItemGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workItemGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workItemGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
