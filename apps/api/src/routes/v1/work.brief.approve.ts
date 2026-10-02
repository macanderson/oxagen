import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workBriefApprove } from "@oxagen/oxagen/contracts/work.brief.approve";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Approve the latest acceptance brief for a work item's current revision
 * (`approve_work_brief`, ADR-251).
 *
 * It answers 200. Mounted on the org-scoped router. The handler refuses an
 * API key and an agent run, so only a signed-in person decides work.
 */
export const workBriefApproveRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/items/brief/approve
workBriefApproveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workBriefApprove.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workBriefApprove.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
