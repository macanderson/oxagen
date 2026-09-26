import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runtimeCreate } from "@oxagen/oxagen/contracts/runtime.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Name a runtime in this workspace; the slug is derived from the name unless one is given. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const runtimeCreateRoute = new Hono<AppEnv>();

runtimeCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runtimeCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runtimeCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
