import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMemoryPrRecordDrop } from "@oxagen/oxagen/contracts/steering.memory_pr_records.drop";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Drop one proposed record from an open memory PR (`drop_memory_record`,
 * #4518). It answers 200 with the commit that deleted the record's file, or
 * the commit that already had. Mounted on the org-scoped router.
 */
export const steeringMemoryPrRecordDropRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/memory-prs/records/drop
steeringMemoryPrRecordDropRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMemoryPrRecordDrop.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMemoryPrRecordDrop.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
