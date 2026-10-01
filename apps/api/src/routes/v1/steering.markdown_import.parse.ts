import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Read Markdown files into proposed steering records and Cedar policies
 * (`parse_markdown_import`, #4907). Writes nothing, so it answers 200.
 * Mounted on the org-scoped router.
 */
export const steeringMarkdownImportParseRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/import/parse
steeringMarkdownImportParseRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMarkdownImportParse.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMarkdownImportParse.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
