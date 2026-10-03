import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringRepoAdopt } from "@oxagen/oxagen/contracts/steering_repo.adopt";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Adopt host merges of pull requests Oxagen opened on the workspace's
 * steering repo (`adopt_steering_merges`, #5195). The body is `{}`. The
 * caller must be someone the governance mode lets merge. Mounted on the
 * org-scoped router.
 */
export const steeringRepoAdoptRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/repo/adopt
steeringRepoAdoptRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringRepoAdopt.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringRepoAdopt.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
