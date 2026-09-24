import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runSeal } from "@oxagen/oxagen/contracts/run.seal";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Seal a live or idle-closed wrapped run and queue a kill for its agent (ADR-169); org Owner or Admin, or workspace Owner. Mounted on the org-scoped router behind session auth. */
export const runSealRoute = new Hono<AppEnv>();

runSealRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runSeal.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runSeal.name, input, ctx, { surface: "api" });
  return c.json(output);
});
