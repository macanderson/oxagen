import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workItemCreate } from "@oxagen/oxagen/contracts/work.item.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Enter a work item by hand (`create_work_item`, P1-03, #5103). It answers 201.
 * Mounted on the org-scoped router.
 */
export const workItemCreateRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/items/create
workItemCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workItemCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workItemCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
