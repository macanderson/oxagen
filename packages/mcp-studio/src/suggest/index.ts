// suggest: the classification Studio fills in for an imported tool (lane M4;
// mcp-studio-spec, Risk classification, Suggestions).
//
// A person confirms or changes the suggestion before the steering PR opens.
// A server's annotations are its author's hints, which MCP tells clients to
// treat as untrusted, so a suggestion is never applied without a person.
//
// The rows, first match wins:
//
// - readOnlyHint true, GET or HEAD, a GraphQL query, or a gRPC method marked
//   NO_SIDE_EFFECTS: read, low.
// - destructiveHint true, or DELETE: irreversible, high, destroys_data.
// - destructiveHint false, POST, PUT, or PATCH, a GraphQL mutation, or a gRPC
//   method marked IDEMPOTENT: write, medium.
// - no annotations, or a gRPC method with no idempotency level: write, high.
//
// Egress: local for a local command, org_tenant through a relay or when
// openWorldHint is false, and third_party otherwise. An operation's
// x-oxagen-tool overrides any row for the keys it sets.
import type { ToolsEntry } from "../contract/tools";
import type { ServerSourceType } from "../contract/server";
import type { UpstreamTool } from "../model/upstream-tool";
import { notBuilt } from "../not-built";

/** Which signal a suggestion came from, so Studio can say why. */
export type SuggestionBasis =
  | "source_hint"
  | "annotations"
  | "http_method"
  | "graphql_operation"
  | "grpc_idempotency"
  | "fail_safe";

/** The four keys tools.toml takes from a suggestion, and the signal they came from. */
export type ClassificationSuggestion = Required<Pick<ToolsEntry, "risk" | "side_effect" | "egress">> & {
  impacts: NonNullable<ToolsEntry["impacts"]>;
  /** The signal the side effect and risk came from. source_hint is x-oxagen-tool. */
  basis: SuggestionBasis;
};

export interface SuggestContext {
  source: ServerSourceType;
  /** The network of the environment agents use: cloud or relay:<name>. Undefined for a local server. */
  network: string | undefined;
}

/** The classification Studio suggests for one imported tool. */
export function suggest(tool: UpstreamTool, context: SuggestContext): ClassificationSuggestion {
  return notBuilt("suggest", tool, context);
}
