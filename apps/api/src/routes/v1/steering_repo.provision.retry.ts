import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Re-send a failed or blocked steering repo setup so it runs again
 * (`retry_steering_repo_provision`, #4750). The body is `{}`. Org Owners and
 * Admins only. Mounted on the org-scoped router.
 */
export const steeringRepoProvisionRetryRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/repo/retry
steeringRepoProvisionRetryRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringRepoProvisionRetry.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringRepoProvisionRetry.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
