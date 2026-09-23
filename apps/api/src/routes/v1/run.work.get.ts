import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runWorkGet } from "@oxagen/oxagen/contracts/run.work.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read a run’s checkout evidence and connected pull requests. */
export const runWorkGetRoute = new Hono<AppEnv>();

runWorkGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runWorkGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runWorkGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
