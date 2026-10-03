import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioTry } from "@oxagen/oxagen/contracts/tool.studio.try";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioTry.input.shape.server.describe(
    "The server folder under tools/servers/ that holds the tool",
  ),
  tool: toolStudioTry.input.shape.tool.describe(
    "The tool's tools.toml key, the name the agent sees, or the upstream name it selects",
  ),
  environment: toolStudioTry.input.shape.environment.describe(
    "The environment in server.toml to call, such as staging",
  ),
  arguments: toolStudioTry.input.shape.arguments.describe(
    "The tool's arguments, checked against its input schema before the call",
  ),
  agent: toolStudioTry.input.shape.agent.describe(
    "The published agent whose policies decide the call. Leave it out when the workspace publishes one agent",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioTry.name,
  description: toolStudioTry.description,
  annotations: {
    // The call reaches the upstream API, which can change data there.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function toolStudioTryTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioTry.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(toolStudioTry.output.parse(output));
}
