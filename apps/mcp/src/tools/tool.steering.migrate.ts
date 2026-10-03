import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolSteeringMigrate } from "@oxagen/oxagen/contracts/tool.steering.migrate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = toolSteeringMigrate.input.shape;

// A second call answers the PR the first one opened, or that the workspace
// has migrated, and opens nothing new.
export const metadata: ToolMetadata = {
  name: toolSteeringMigrate.name,
  description: toolSteeringMigrate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function migrateToolsToSteeringTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolSteeringMigrate.name, {}, ctx, {
    surface: "mcp",
  });
  return toolResult(toolSteeringMigrate.output.parse(output));
}
