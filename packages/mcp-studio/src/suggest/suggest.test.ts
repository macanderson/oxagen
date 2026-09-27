// suggest: every row of the spec's Suggestions table, each egress rule, and
// how an x-oxagen-tool hint overrides a row.
import { describe, expect, it } from "vitest";
import type { LockedMcpToolAnnotations } from "../contract/mcp-tool";
import type { GrpcIdempotencyLevel, HttpRequest, ToolSuggestion, UpstreamTool } from "../model/upstream-tool";
import { suggest, type ClassificationSuggestion, type SuggestContext } from "./index";

const INPUT = { type: "object" } as const;
const CLOUD: SuggestContext = { source: "openapi", network: "cloud" };

function mcpTool(annotations?: LockedMcpToolAnnotations): UpstreamTool {
  return { name: "tool", inputSchema: INPUT, annotations, request: { kind: "mcp", tool: "tool" } };
}

function httpTool(method: HttpRequest["method"], suggestion?: ToolSuggestion): UpstreamTool {
  return {
    name: "operation",
    inputSchema: INPUT,
    suggestion,
    request: { kind: "http", operation: "operation", method, path: "/things", parameters: [] },
  };
}

function graphqlTool(operation_type: "query" | "mutation"): UpstreamTool {
  return {
    name: "field",
    inputSchema: INPUT,
    request: { kind: "graphql", operation_type, field: "Query.field", arguments: [] },
  };
}

function grpcTool(idempotency_level: GrpcIdempotencyLevel): UpstreamTool {
  return {
    name: "method",
    inputSchema: INPUT,
    request: {
      kind: "grpc",
      method: "acme.v1.Things/Method",
      streaming: "unary",
      idempotency_level,
      request_type: "acme.v1.Request",
      response_type: "acme.v1.Response",
    },
  };
}

type Row = Omit<ClassificationSuggestion, "egress" | "basis">;

const READ: Row = { side_effect: "read", risk: "low", impacts: [] };
const WRITE: Row = { side_effect: "write", risk: "medium", impacts: [] };
const IRREVERSIBLE: Row = { side_effect: "irreversible", risk: "high", impacts: ["destroys_data"] };
const FAIL_SAFE: Omit<ClassificationSuggestion, "egress"> = {
  side_effect: "write",
  risk: "high",
  impacts: [],
  basis: "fail_safe",
};

describe("suggest", () => {
  it.each<[string, UpstreamTool, Omit<ClassificationSuggestion, "egress">]>([
    ["readOnlyHint true", mcpTool({ readOnlyHint: true }), { ...READ, basis: "annotations" }],
    [
      "readOnlyHint true over destructiveHint true",
      mcpTool({ readOnlyHint: true, destructiveHint: true }),
      { ...READ, basis: "annotations" },
    ],
    ["destructiveHint true", mcpTool({ destructiveHint: true }), { ...IRREVERSIBLE, basis: "annotations" }],
    [
      "destructiveHint false",
      mcpTool({ readOnlyHint: false, destructiveHint: false }),
      { ...WRITE, basis: "annotations" },
    ],
    ["no annotations", mcpTool(), FAIL_SAFE],
    ["annotations that set neither hint", mcpTool({ readOnlyHint: false, idempotentHint: true }), FAIL_SAFE],
    ["GET", httpTool("GET"), { ...READ, basis: "http_method" }],
    ["HEAD", httpTool("HEAD"), { ...READ, basis: "http_method" }],
    ["DELETE", httpTool("DELETE"), { ...IRREVERSIBLE, basis: "http_method" }],
    ["POST", httpTool("POST"), { ...WRITE, basis: "http_method" }],
    ["PUT", httpTool("PUT"), { ...WRITE, basis: "http_method" }],
    ["PATCH", httpTool("PATCH"), { ...WRITE, basis: "http_method" }],
    ["OPTIONS", httpTool("OPTIONS"), FAIL_SAFE],
    ["TRACE", httpTool("TRACE"), FAIL_SAFE],
    ["a GraphQL query", graphqlTool("query"), { ...READ, basis: "graphql_operation" }],
    ["a GraphQL mutation", graphqlTool("mutation"), { ...WRITE, basis: "graphql_operation" }],
    ["a gRPC method marked NO_SIDE_EFFECTS", grpcTool("NO_SIDE_EFFECTS"), { ...READ, basis: "grpc_idempotency" }],
    ["a gRPC method marked IDEMPOTENT", grpcTool("IDEMPOTENT"), { ...WRITE, basis: "grpc_idempotency" }],
    ["a gRPC method with no idempotency level", grpcTool("IDEMPOTENCY_UNKNOWN"), FAIL_SAFE],
  ])("suggests the row for %s", (_row, tool, expected) => {
    expect(suggest(tool, CLOUD)).toEqual({ ...expected, egress: "third_party" });
  });

  it("reads an operation by its method, not by the annotations its importer implied", () => {
    const put = { ...httpTool("PUT"), annotations: { idempotentHint: true, destructiveHint: false } };
    expect(suggest(put, CLOUD).basis).toBe("http_method");
  });

  it.each<[string, UpstreamTool, SuggestContext, ClassificationSuggestion["egress"]]>([
    ["a local command", mcpTool(), { source: "local", network: undefined }, "local"],
    ["a registry package the local gateway runs", mcpTool(), { source: "registry", network: undefined }, "local"],
    ["a relay", httpTool("GET"), { source: "openapi", network: "relay:a-intel-east" }, "org_tenant"],
    ["openWorldHint false", mcpTool({ openWorldHint: false }), { source: "remote", network: "cloud" }, "org_tenant"],
    ["openWorldHint true", mcpTool({ openWorldHint: true }), { source: "remote", network: "cloud" }, "third_party"],
    ["a cloud server", httpTool("GET"), { source: "openapi", network: "cloud" }, "third_party"],
  ])("gives %s egress %s", (_case, tool, context, egress) => {
    expect(suggest(tool, context).egress).toBe(egress);
  });

  it("takes every key an x-oxagen-tool hint sets", () => {
    const hint: ToolSuggestion = {
      risk: "high",
      side_effect: "irreversible",
      egress: "org_tenant",
      impacts: ["moves_money"],
    };
    expect(suggest(httpTool("POST", hint), CLOUD)).toEqual({
      side_effect: "irreversible",
      risk: "high",
      egress: "org_tenant",
      impacts: ["moves_money"],
      basis: "source_hint",
    });
  });

  it("keeps the row for every key the hint leaves out", () => {
    expect(suggest(httpTool("DELETE", { risk: "medium" }), CLOUD)).toEqual({
      ...IRREVERSIBLE,
      risk: "medium",
      egress: "third_party",
      basis: "source_hint",
    });
  });

  it("keeps the row's basis when the hint sets neither the side effect nor the risk", () => {
    expect(suggest(httpTool("GET", { egress: "org_tenant", impacts: ["alters_production"] }), CLOUD)).toEqual({
      ...READ,
      impacts: ["alters_production"],
      egress: "org_tenant",
      basis: "http_method",
    });
    expect(suggest(httpTool("GET", { name: "fetch_thing" }), CLOUD)).toEqual({
      ...READ,
      egress: "third_party",
      basis: "http_method",
    });
  });

  it("suggests billing's get_charge from its x-oxagen-tool hint", () => {
    const getCharge = httpTool("GET", { egress: "org_tenant", risk: "low", side_effect: "read" });
    expect(suggest(getCharge, { source: "openapi", network: "relay:a-intel-east" })).toEqual({
      ...READ,
      egress: "org_tenant",
      basis: "source_hint",
    });
  });
});
