import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Import a registered MCP server's pinned tools, or declarations against it, into the registry. Mounted on the org-scoped router behind session auth. */
export const toolImportRoute = new Hono<AppEnv>();

toolImportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolImport.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolImport.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
