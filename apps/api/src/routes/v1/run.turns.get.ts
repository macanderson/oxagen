import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runTurnsGet } from "@oxagen/oxagen/contracts/run.turns.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one run's per-turn ledger. Mounted on the org-scoped router behind session auth. */
export const runTurnsGetRoute = new Hono<AppEnv>();

runTurnsGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runTurnsGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runTurnsGet.name, input, ctx, { surface: "api" });
  return c.json(output);
});
