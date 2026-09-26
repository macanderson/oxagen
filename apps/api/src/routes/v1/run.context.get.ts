import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runContextGet } from "@oxagen/oxagen/contracts/run.context.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read the context window of each of one run's model requests. Mounted on the org-scoped router behind session auth. */
export const runContextGetRoute = new Hono<AppEnv>();

runContextGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runContextGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runContextGet.name, input, ctx, { surface: "api" });
  return c.json(output);
});
