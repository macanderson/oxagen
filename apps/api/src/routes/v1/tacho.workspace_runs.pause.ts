import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { pauseWorkspaceRuns } from "@oxagen/oxagen/contracts/tacho.workspace_runs.pause";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Pause every live wrapped run in the workspace the URL names, as one
 * decision with one audit event (`pause_workspace_runs`). Mounted on the
 * org-scoped router behind session auth. The workspace is the caller's
 * scope, so the body carries only the reason.
 */
export const tachoWorkspaceRunsPauseRoute = new Hono<AppEnv>();

tachoWorkspaceRunsPauseRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = pauseWorkspaceRuns.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(pauseWorkspaceRuns.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
