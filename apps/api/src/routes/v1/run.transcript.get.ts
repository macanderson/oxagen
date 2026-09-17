import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one run as a transcript at a zoom level. Mounted on the org-scoped router behind session auth. */
export const runTranscriptGetRoute = new Hono<AppEnv>();

runTranscriptGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runTranscriptGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runTranscriptGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
