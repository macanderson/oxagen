import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runOutputsGet } from "@oxagen/oxagen/contracts/run.outputs.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read what one run produced. The handler answers a signed-in member only. */
export const runOutputsGetRoute = new Hono<AppEnv>();

runOutputsGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runOutputsGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runOutputsGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
