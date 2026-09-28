import { Hono } from "hono";
import { steeringRepoGet } from "@oxagen/oxagen/contracts/steering_repo.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * The workspace's steering repo: provisioning status and step, the
 * repository, the published version, and the settings health
 * (`get_steering_repo`). Mounted on the org-scoped router.
 */
export const steeringRepoGetRoute = new Hono<AppEnv>();

// GET /v1/:org_slug/:workspace_slug/context/steering/repo
steeringRepoGetRoute.get("/", async (c) => {
  const input = steeringRepoGet.input.parse({});
  const ctx = capabilityContext(c);
  const output = await invoke(steeringRepoGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
