import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workTargetsList } from "@oxagen/oxagen/contracts/work.targets.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the workspace's agents and whether each can take a send now (`list_work_targets`, P1-05, #5163). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const workTargetsListRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/targets/list
workTargetsListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workTargetsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workTargetsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
