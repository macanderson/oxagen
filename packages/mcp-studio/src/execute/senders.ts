// senders.ts: the Sender execute() uses for each request template kind.
import { createGraphqlSender } from "./graphql";
import { grpcSender } from "./grpc";
import { createHttpSender } from "./http";
import { createMcpSender } from "./mcp";
import type { Sender, Senders } from "./sender";

/**
 * tools/call with the upstream name, over a streamable HTTP session. Retries
 * only when the server cannot have received the call.
 */
export const mcpSender: Sender<"mcp"> = createMcpSender();

/**
 * The request built from an OpenAPI operation. Retries GET, HEAD, OPTIONS,
 * PUT, DELETE, and a keyed POST on 429, 502, 503, and 504, up to 3 times,
 * after Retry-After.
 */
export const httpSender: Sender<"http"> = createHttpSender();

/** One POST with the selection set and the arguments as variables. A query retries as GET does. A mutation never does. */
export const graphqlSender: Sender<"graphql"> = createGraphqlSender();

/** The default Sender for each kind. */
export const defaultSenders: Senders = { mcp: mcpSender, http: httpSender, graphql: graphqlSender, grpc: grpcSender };
