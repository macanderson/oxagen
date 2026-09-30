import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioCredentialSet } from "@oxagen/oxagen/contracts/tool.studio.credential.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Create or replace one named MCP credential in the workspace. The body
 * carries a secret, so the route logs nothing from it and answers with the
 * name and reference only. Mounted on the org-scoped router behind session auth.
 */
export const toolStudioCredentialSetRoute = new Hono<AppEnv>();

toolStudioCredentialSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioCredentialSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioCredentialSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
