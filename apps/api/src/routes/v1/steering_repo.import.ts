import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringRepoImport } from "@oxagen/oxagen/contracts/steering_repo.import";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Move the workspace's steering from `.oxagen/` to a steering repo
 * (`import_workspace_steering`). The body is `{}`, or the choices a
 * `needs_choices` answer asked for. Org Owners and Admins, and workspace
 * Owners. Mounted on the org-scoped router.
 */
export const steeringRepoImportRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/repo/import
steeringRepoImportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringRepoImport.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringRepoImport.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
