import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workCollectorSync } from "@oxagen/oxagen/contracts/work.collector.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Queue a reconcile of one work collector now (`sync_work_collector`, P1-03, #5103). It answers 202.
 * Mounted on the org-scoped router.
 */
export const workCollectorSyncRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/collectors/sync
workCollectorSyncRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workCollectorSync.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workCollectorSync.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 202);
});
