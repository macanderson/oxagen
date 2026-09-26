import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolbeltDelete } from "@oxagen/oxagen/contracts/toolbelt.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Delete a custom toolbelt no live agent carries. The handler checks the role. Mounted on the org-scoped router behind session auth. */
export const toolbeltDeleteRoute = new Hono<AppEnv>();

toolbeltDeleteRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolbeltDelete.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolbeltDelete.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
