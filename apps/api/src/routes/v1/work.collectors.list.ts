import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workCollectorsList } from "@oxagen/oxagen/contracts/work.collectors.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the workspace's work collectors with their health (`list_work_collectors`, P1-03, #5103). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const workCollectorsListRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/collectors/list
workCollectorsListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workCollectorsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workCollectorsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
