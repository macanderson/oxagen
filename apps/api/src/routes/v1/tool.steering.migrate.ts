import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolSteeringMigrate } from "@oxagen/oxagen/contracts/tool.steering.migrate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Start or retry the move of the workspace's MCP servers into its steering
 * repo (`migrate_tools_to_steering`, ADR-245). The body is `{}`. Org Owners
 * and Admins only. Mounted on the org-scoped router.
 */
export const toolSteeringMigrateRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/tools/steering/migrate
toolSteeringMigrateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolSteeringMigrate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolSteeringMigrate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
