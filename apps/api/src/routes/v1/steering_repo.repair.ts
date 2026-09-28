import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringRepoRepair } from "@oxagen/oxagen/contracts/steering_repo.repair";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Put every prescribed setting back on the workspace's steering repo
 * (`repair_steering_repo`). The body is `{}`. Org Owners and Admins only.
 * Mounted on the org-scoped router.
 */
export const steeringRepoRepairRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/repo/repair
steeringRepoRepairRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringRepoRepair.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringRepoRepair.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
