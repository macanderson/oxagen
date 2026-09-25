import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { workingCopyRecord } from "@oxagen/oxagen/contracts/repository.working_copy.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Record a directory the CLI linked to this workspace (`record_working_copy`). `oxagen init` and `oxagen pull` send it. Mounted on the org-scoped router at `/working-copies`. */
export const workingCopyRecordRoute = new Hono<AppEnv>();

workingCopyRecordRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = workingCopyRecord.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workingCopyRecord.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
