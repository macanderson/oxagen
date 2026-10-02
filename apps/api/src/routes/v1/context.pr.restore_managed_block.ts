import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextPrRestoreManagedBlock } from "@oxagen/oxagen/contracts/context.pr.restore_managed_block";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Put Oxagen's managed block back in one file of an open steering PR
 * (`restore_managed_block`, #4518). The body names the proposal and the file.
 * The capability adds one commit to the PR's branch, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const contextPrRestoreManagedBlockRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/prs/restore-block
contextPrRestoreManagedBlockRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = contextPrRestoreManagedBlock.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextPrRestoreManagedBlock.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
