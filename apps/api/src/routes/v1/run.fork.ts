import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runFork } from "@oxagen/oxagen/contracts/run.fork";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Mint a fork attempt of a ledger run at a frame; org Owner, Admin or Member. Mounted on the org-scoped router behind session auth. */
export const runForkRoute = new Hono<AppEnv>();

runForkRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runFork.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runFork.name, input, ctx, { surface: "api" });
  return c.json(output);
});
