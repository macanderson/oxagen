import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workBriefSave } from "@oxagen/oxagen/contracts/work.brief.save";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Save a new revision of a work item's acceptance brief (`save_work_brief`,
 * ADR-250).
 *
 * It answers 200. Mounted on the org-scoped router. The handler refuses an
 * API key and an agent run, so only a signed-in person decides work.
 */
export const workBriefSaveRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/work/items/brief/save
workBriefSaveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = workBriefSave.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workBriefSave.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
