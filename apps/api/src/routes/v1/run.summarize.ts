import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runSummarize } from "@oxagen/oxagen/contracts/run.summarize";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Queue the generated name and summary of a sealed run. Mounted on the org-scoped router behind session auth. */
export const runSummarizeRoute = new Hono<AppEnv>();

runSummarizeRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runSummarize.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runSummarize.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
