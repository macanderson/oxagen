import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpAuthorizeStart } from "@oxagen/oxagen/contracts/agent.mcp.authorize.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

const shape = agentMcpAuthorizeStart.input.shape;

export const schema = {
  mcpServerId: shape.mcpServerId.describe(
    "Reconnect this provider (mcs_…) instead of adding one",
  ),
  name: shape.name.describe("The provider's display name, when adding one"),
  endpointUrl: shape.endpointUrl.describe(
    "The server's streamable-http endpoint, when adding one",
  ),
  description: shape.description.describe("A one-line description"),
  iconUrl: shape.iconUrl.describe("An https icon URL"),
  registryId: shape.registryId.describe(
    "The registry id the provider was picked from",
  ),
  client: shape.client.describe(
    "The workspace's own OAuth app, for a server that registers no clients",
  ),
  redirectUrl: shape.redirectUrl.describe(
    "The app's callback, <origin>/api/v1/mcp/oauth/callback",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpAuthorizeStart.name,
  description: agentMcpAuthorizeStart.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function agentMcpAuthorizeStartTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpAuthorizeStart.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpAuthorizeStart.output.parse(output);
}
