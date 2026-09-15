import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Archive a workspace of the org (issue #2964). Mounted on the org-scoped router behind session auth. */
export const workspaceArchiveRoute = new Hono<AppEnv>();

workspaceArchiveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = workspaceArchive.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workspaceArchive.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
