import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runProofGet } from "@oxagen/oxagen/contracts/run.proof.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one run's proof record. The handler answers a signed-in member only. */
export const runProofGetRoute = new Hono<AppEnv>();

runProofGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runProofGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runProofGet.name, input, ctx, { surface: "api" });
  return c.json(output);
});
