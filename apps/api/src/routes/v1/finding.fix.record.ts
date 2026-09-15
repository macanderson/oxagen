import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { findingFixRecord } from "@oxagen/oxagen/contracts/finding.fix.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Record that an open finding's fix was applied (org Owner or Admin; checked in the handler). Mounted on the org-scoped router behind session auth. */
export const findingFixRecordRoute = new Hono<AppEnv>();

findingFixRecordRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = findingFixRecord.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(findingFixRecord.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
