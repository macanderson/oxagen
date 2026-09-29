import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolRelayRevoke } from "@oxagen/oxagen/contracts/tool.relay.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// create_relay has no MCP tool. Its answer carries a plaintext relay token,
// and a tool would put that token in the agent's transcript. Revoking puts no
// secret in the transcript, so an agent may revoke a relay it suspects is
// compromised.
export const schema = {
  name: toolRelayRevoke.input.shape.name.describe(
    "The name of the live relay to revoke in this workspace, the <name> in a call's relay:<name> network",
  ),
};

export const metadata: ToolMetadata = {
  name: toolRelayRevoke.name,
  description: toolRelayRevoke.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // A second call finds no live relay and answers not_found.
    idempotentHint: false,
  },
};

export default async function revokeRelayTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const input = toolRelayRevoke.input.parse(args);
  const output = await invoke(toolRelayRevoke.name, input, ctx, {
    surface: "mcp",
  });
  return toolRelayRevoke.output.parse(output);
}
