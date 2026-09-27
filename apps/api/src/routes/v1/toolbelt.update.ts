import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolbeltUpdate } from "@oxagen/oxagen/contracts/toolbelt.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Rename a custom toolbelt and edit its servers and tools. The handler checks the role. Mounted on the org-scoped router behind session auth. */
export const toolbeltUpdateRoute = new Hono<AppEnv>();

toolbeltUpdateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolbeltUpdate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolbeltUpdate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
