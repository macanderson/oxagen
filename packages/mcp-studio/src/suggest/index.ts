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
// Each tool is read by its request kind. Only an MCP tool's annotations
// decide its side effect, because an importer writes an operation's
// annotations from the same method or idempotency level this reads. A tool no
// row matches takes the last row, the fail-safe import_tools uses today: an
// MCP tool whose annotations set neither hint, and an OPTIONS or TRACE
// operation.
//
// Egress: local for a local command, org_tenant through a relay or when
// openWorldHint is false, and third_party otherwise. An operation's
// x-oxagen-tool overrides any row for the keys it sets.
import type { ToolsEntry } from "../contract/tools";
import type { ServerSourceType } from "../contract/server";
import type { UpstreamTool } from "../model/upstream-tool";

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

/** A row of the Suggestions table: everything but egress. */
type Row = Omit<ClassificationSuggestion, "egress">;

function read(basis: SuggestionBasis): Row {
  return { side_effect: "read", risk: "low", impacts: [], basis };
}

function irreversible(basis: SuggestionBasis): Row {
  return { side_effect: "irreversible", risk: "high", impacts: ["destroys_data"], basis };
}

function write(basis: SuggestionBasis): Row {
  return { side_effect: "write", risk: "medium", impacts: [], basis };
}

function failSafe(): Row {
  return { side_effect: "write", risk: "high", impacts: [], basis: "fail_safe" };
}

function rowOf(tool: UpstreamTool): Row {
  const { request } = tool;
  switch (request.kind) {
    case "mcp": {
      const hints = tool.annotations;
      if (hints?.readOnlyHint === true) return read("annotations");
      if (hints?.destructiveHint === true) return irreversible("annotations");
      if (hints?.destructiveHint === false) return write("annotations");
      return failSafe();
    }
    case "http":
      switch (request.method) {
        case "GET":
        case "HEAD":
          return read("http_method");
        case "DELETE":
          return irreversible("http_method");
        case "POST":
        case "PUT":
        case "PATCH":
          return write("http_method");
        default:
          return failSafe();
      }
    case "graphql":
      return request.operation_type === "query" ? read("graphql_operation") : write("graphql_operation");
    case "grpc":
      if (request.idempotency_level === "NO_SIDE_EFFECTS") return read("grpc_idempotency");
      if (request.idempotency_level === "IDEMPOTENT") return write("grpc_idempotency");
      return failSafe();
  }
}

function egressOf(tool: UpstreamTool, context: SuggestContext): ClassificationSuggestion["egress"] {
  if (context.source === "local" || context.network === undefined) return "local";
  if (context.network.startsWith("relay:") || tool.annotations?.openWorldHint === false) return "org_tenant";
  return "third_party";
}

/**
 * The classification Studio suggests for one imported tool. An x-oxagen-tool
 * hint replaces each key it sets and leaves the others to the table. The
 * basis is source_hint when the hint sets the side effect or the risk, the two
 * keys the basis explains.
 */
export function suggest(tool: UpstreamTool, context: SuggestContext): ClassificationSuggestion {
  const row = rowOf(tool);
  const suggested: ClassificationSuggestion = { ...row, egress: egressOf(tool, context) };
  const hint = tool.suggestion;
  if (hint === undefined) return suggested;
  return {
    side_effect: hint.side_effect ?? suggested.side_effect,
    risk: hint.risk ?? suggested.risk,
    egress: hint.egress ?? suggested.egress,
    impacts: hint.impacts ?? suggested.impacts,
    basis: hint.side_effect !== undefined || hint.risk !== undefined ? "source_hint" : suggested.basis,
  };
}
