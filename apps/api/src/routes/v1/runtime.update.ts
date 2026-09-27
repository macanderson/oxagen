import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runtimeUpdate } from "@oxagen/oxagen/contracts/runtime.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Rename a runtime or change whether it requires the contained launcher (ADR-204). A field left out keeps its value. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const runtimeUpdateRoute = new Hono<AppEnv>();

runtimeUpdateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runtimeUpdate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runtimeUpdate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
