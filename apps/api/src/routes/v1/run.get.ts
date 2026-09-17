import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one run's header and a page of its frames. Mounted on the org-scoped router behind session auth. */
export const runGetRoute = new Hono<AppEnv>();

runGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runGet.name, input, ctx, { surface: "api" });
  return c.json(output);
});
