// execute: run one tool call from the manifest (lane M6; mcp-studio-spec,
// Call path, steps 3 and 5 to 9).
//
// execute() validates the arguments against the effective input schema,
// shapes the input, resolves the credential, sends through the Sender for
// the request template kind, and shapes the result into an MCP tools/call
// result. The decision (step 4) happened before it was called.
import type { ManifestServer, ManifestTool } from "../contract/manifest";
import { notBuiltAsync } from "../not-built";
import type { CredentialSource } from "./credentials";
import type { Sender } from "./sender";
import type { CallToolResult, Transport } from "./transport";

export * from "./credentials";
export * from "./sender";
export * from "./transport";
export { grpcSender, type GrpcStreamResult } from "./grpc";

/** Where a call runs: the server, the environment, and the person running the agent. */
export interface CallEnvironment {
  server: ManifestServer;
  /** A key of server.environments: the sandbox for an agent's call, or the one an operator picked in Try it. */
  name: string;
  /** The operator, for operator-oauth. */
  operator: string | undefined;
}

/**
 * Run one call and return the MCP tools/call result the agent receives. An
 * upstream failure, a schema error, and a missing operator token are isError
 * results. It rejects only when the CredentialSource rejects.
 */
export function execute(
  tool: ManifestTool,
  args: Record<string, unknown>,
  environment: CallEnvironment,
  credentials: CredentialSource,
  transport: Transport,
): Promise<CallToolResult> {
  return notBuiltAsync("execute", tool, args, environment, credentials, transport);
}

/** tools/call with the upstream name. Retries only when the Transport failed before the server received the call. */
export const mcpSender: Sender<"mcp"> = {
  kind: "mcp",
  send: (template, args, context) => notBuiltAsync("execute/mcp", template, args, context),
};

/**
 * The request built from an OpenAPI operation. Retries GET, HEAD, PUT,
 * DELETE, and a keyed POST on 429, 502, 503, and 504, up to 3 times, after
 * Retry-After.
 */
export const httpSender: Sender<"http"> = {
  kind: "http",
  send: (template, args, context) => notBuiltAsync("execute/http", template, args, context),
};

/** One POST with the selection set and the arguments as variables. A query retries as GET does. A mutation never does. */
export const graphqlSender: Sender<"graphql"> = {
  kind: "graphql",
  send: (template, args, context) => notBuiltAsync("execute/graphql", template, args, context),
};
