import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Set a tool version's safety classification. Mounted on the org-scoped router behind session auth. */
export const toolClassificationSetRoute = new Hono<AppEnv>();

toolClassificationSetRoute.put("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolClassificationSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolClassificationSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
