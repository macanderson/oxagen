import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Derived from the contract shape, like every other tool in this directory.
// A hand-written copy of the trigger schema used to live here and had already
// drifted: it omitted `conditionTree` (the preferred, schema-driven condition
// form) and advertised the deprecated flat `propertyConditions` as the only
// option, so MCP clients could not express the modern form at all.
export const schema = {
  ...automationCreate.input.shape,
};

export const metadata: ToolMetadata = {
  name: automationCreate.name,
  description: automationCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function automationCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationCreate.name, args, ctx, {
    surface: "mcp",
  });
  return automationCreate.output.parse(output);
}
