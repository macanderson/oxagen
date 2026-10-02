import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMemoryPrRecordsList } from "@oxagen/oxagen/contracts/steering.memory_pr_records.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the records of one memory PR for the memory PR review card
 * (`list_memory_pr_records`, #4912). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const steeringMemoryPrRecordsListRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/memory-prs/records
steeringMemoryPrRecordsListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMemoryPrRecordsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMemoryPrRecordsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
