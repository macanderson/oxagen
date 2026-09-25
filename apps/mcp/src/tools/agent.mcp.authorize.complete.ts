import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpAuthorizeComplete } from "@oxagen/oxagen/contracts/agent.mcp.authorize.complete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

const shape = agentMcpAuthorizeComplete.input.shape;

export const schema = {
  state: shape.state.describe(
    "The state start_mcp_authorization returned",
  ),
  code: shape.code.describe("The code the authorization server returned"),
  redirectUrl: shape.redirectUrl.describe(
    "The same callback the authorization was started with",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpAuthorizeComplete.name,
  description: agentMcpAuthorizeComplete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function agentMcpAuthorizeCompleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpAuthorizeComplete.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpAuthorizeComplete.output.parse(output);
}
