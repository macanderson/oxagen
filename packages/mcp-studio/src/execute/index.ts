// execute: run one tool call from the manifest (lane M6; mcp-studio-spec,
// Call path, steps 3 and 5 to 9).
//
// execute() validates the arguments against the effective input schema,
// shapes the input, resolves the credential, sends through the Sender for
// the request template kind, pages when tools.toml asks, and shapes the
// result into an MCP tools/call result. The decision (step 4) happened
// before it was called.
import type { ManifestTool } from "../contract/manifest";
import { executeCall, type CallEnvironment, type ExecuteOptions } from "./call";
import type { CredentialSource } from "./credentials";
import type { CallToolResult, Transport } from "./transport";

export * from "./credentials";
export * from "./sender";
export * from "./transport";
export { executeCall, type CallEnvironment, type ExecutedCall, type ExecuteOptions } from "./call";
export { createGraphqlSender, type GraphqlSenderOptions } from "./graphql";
export { grpcSender, type GrpcStreamResult } from "./grpc";
export { createHttpSender, type HttpSenderOptions } from "./http";
export { createMcpSender, MCP_PROTOCOL_VERSION, sendLocal, type McpSenderOptions } from "./mcp";
export { defaultSenders, graphqlSender, httpSender, mcpSender } from "./senders";

/**
 * Run one call and return the MCP tools/call result the agent receives. An
 * upstream failure, a schema error, and a missing operator token are isError
 * results. It rejects only when the CredentialSource rejects. executeCall
 * returns the same result with each exchange, for Studio to save as a test.
 */
export async function execute(
  tool: ManifestTool,
  args: Record<string, unknown>,
  environment: CallEnvironment,
  credentials: CredentialSource,
  transport: Transport,
  options: ExecuteOptions = {},
): Promise<CallToolResult> {
  return (await executeCall(tool, args, environment, credentials, transport, options)).result;
}
