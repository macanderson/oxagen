// lint: every row of the Tool checks table outside the registry rows, and
// over_definition_budget, each with a folder that trips it and one that does
// not. A case that trips a rule states each finding's message. registry.test.ts
// covers the registry rows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../compile";
import { mcpToolsListResultSchema } from "../contract/mcp-tool";
import { parseLock, parseServerToml, parseToolsToml, type ReadResult } from "../contract/parse";
import { mcpServerSchema, type McpServer } from "../contract/server";
import { mcpToolsSchema, type McpTools } from "../contract/tools";
import { upstreamFromMcpTool } from "../model/from-mcp";
import type { ImportNote } from "../model/import-result";
import { upstreamToolSchema, type UpstreamTool } from "../model/upstream-tool";
import { lint, LINT_RULES, type Finding, type LintContext, type LintRule, type ServerFolder } from "./index";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function text(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function json(path: string): unknown {
  return JSON.parse(text(path)) as unknown;
}

/** The value of a parse that must succeed. A failure shows its issues. */
function ok<T>(result: ReadResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.value;
}

const byText = (a: string, b: string): number => a.localeCompare(b);

// ── Context ──────────────────────────────────────────────────────────────────

/** Every credential the fixtures and builders name. */
const CREDENTIALS: ReadonlySet<string> = new Set([
  "oxagen:credential/billing-oauth-client",
  "oxagen:credential/stripe-test",
  "oxagen:credential/stripe-live",
  "oxagen:credential/acme",
]);

function context(fields: Partial<LintContext> = {}): LintContext {
  return { credentials: CREDENTIALS, accepted_unchanged: new Set(), ...fields };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SERVERS = ["billing", "stripe"] as const;
type FixtureServer = (typeof SERVERS)[number];

/** What each fixture's source offers: stripe's tools/list, or the upstream M1 returns for billing. */
function offeredBy(name: FixtureServer): UpstreamTool[] {
  return name === "stripe"
    ? mcpToolsListResultSchema.parse(json("sources/stripe/tools-list.json")).tools.map(upstreamFromMcpTool)
    : upstreamToolSchema.array().parse(json("expected/billing/upstream.json"));
}

function fixture(name: FixtureServer): ServerFolder {
  return {
    name,
    server: ok(parseServerToml(text(`servers/${name}/server.toml`))),
    tools: ok(parseToolsToml(text(`servers/${name}/tools.toml`))),
    lock: ok(parseLock(text(`servers/${name}/tools.lock.json`))),
    offered: offeredBy(name),
    notes: [],
  };
}

// ── Builders ─────────────────────────────────────────────────────────────────

const READ = { risk: "low", side_effect: "read", egress: "third_party" } as const;
const IRREVERSIBLE = { risk: "high", side_effect: "irreversible", egress: "org_tenant" } as const;

const REMOTE = {
  schema: "mcp-server/v1",
  name: "acme",
  label: "Acme",
  description: "Issues and repositories in the Acme tracker.",
  source: { type: "remote", url: "https://mcp.acme.example", transport: "http" },
  auth: { mode: "service", scheme: "bearer", credential: "oxagen:credential/acme" },
  exposure: { mode: "direct" },
  sync: { schedule: "daily" },
};

/** A server built from a definition at a URL, with one environment and no auth. */
function definitionServer(type: "openapi" | "graphql" | "grpc"): Record<string, unknown> {
  return {
    ...REMOTE,
    source: { type, from: "url", url: `https://docs.acme.example/${type}` },
    auth: { mode: "none" },
    environments: { prod: { url: "https://api.acme.example/v1" } },
  };
}

/** A local server with no machine groups and no auth. */
const LOCAL = {
  schema: "mcp-server/v1",
  name: "acme",
  label: "Acme",
  description: "Issues in the Acme tracker, from a command on the machine.",
  source: { type: "local", command: "acme-mcp" },
  exposure: { mode: "direct" },
  sync: { schedule: "daily" },
};

/** A parsed server.toml: the Acme remote server with fields replaced. */
function server(fields: Record<string, unknown> = {}): McpServer {
  return mcpServerSchema.parse({ ...REMOTE, ...fields });
}

/** A parsed tools.toml with these entries. */
function tools(entries: Record<string, Record<string, unknown>>): McpTools {
  return mcpToolsSchema.parse({ schema: "mcp-tools/v1", tools: entries });
}

/** A tools.toml parse would refuse, for the rules that catch what parse misses on a draft. */
function rawTools(entries: Record<string, Record<string, unknown>>): McpTools {
  return { schema: "mcp-tools/v1", tools: entries } as unknown as McpTools;
}

function upstreamTool(fields: Record<string, unknown>): UpstreamTool {
  return upstreamToolSchema.parse({
    description: "Lists the open issues in one repository.",
    inputSchema: { type: "object" },
    ...fields,
  });
}

function mcpTool(name: string, fields: Record<string, unknown> = {}): UpstreamTool {
  return upstreamTool({ name, request: { kind: "mcp", tool: name }, ...fields });
}

const ID_OUTPUT = { type: "object", properties: { id: { type: "string" } } };

function httpTool(operation: string, fields: Record<string, unknown> = {}): UpstreamTool {
  return upstreamTool({
    name: operation,
    request: { kind: "http", operation, method: "POST", path: "/refunds", parameters: [] },
    outputSchema: ID_OUTPUT,
    ...fields,
  });
}

function graphqlTool(field: string, request: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): UpstreamTool {
  return upstreamTool({
    name: field,
    request: { kind: "graphql", operation_type: "query", field, arguments: [], selection: "{ id }", ...request },
    ...fields,
  });
}

function grpcTool(method: string, request: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): UpstreamTool {
  return upstreamTool({
    name: method.split("/")[1],
    request: {
      kind: "grpc",
      method,
      streaming: "unary",
      idempotency_level: "NO_SIDE_EFFECTS",
      request_type: "acme.ledger.v1.Request",
      response_type: "acme.ledger.v1.Response",
      ...request,
    },
    ...fields,
  });
}

function folder(fields: {
  server?: McpServer;
  tools: McpTools;
  offered: readonly UpstreamTool[];
  notes?: readonly ImportNote[];
}): ServerFolder {
  const srv = fields.server ?? server();
  return { name: srv.name, server: srv, tools: fields.tools, lock: undefined, offered: fields.offered, notes: fields.notes ?? [] };
}

/** The Acme remote server with one list_issues entry over list_issues. */
function issues(entry: Record<string, unknown> = READ, fields: Record<string, unknown> = {}): ServerFolder {
  return folder({ tools: tools({ list_issues: entry }), offered: [mcpTool("list_issues", fields)] });
}

/** A folder built from what an importer returned: expected/openapi/<file>, or the GraphQL fixture. */
function imported(
  type: "openapi" | "graphql",
  path: string,
  entries: Record<string, Record<string, unknown>>,
): ServerFolder {
  const result = json(path);
  const { tools: offered, notes }: { tools: unknown; notes: ImportNote[] } = Array.isArray(result)
    ? { tools: result, notes: [] }
    : (result as { tools: unknown; notes: ImportNote[] });
  return folder({
    server: server(definitionServer(type)),
    tools: tools(entries),
    offered: upstreamToolSchema.array().parse(offered),
    notes,
  });
}

// ── Assertions ───────────────────────────────────────────────────────────────

type Found = [LintRule, string | undefined, string | undefined];

function found(findings: readonly Finding[]): Found[] {
  return findings.map((finding) => [finding.rule, finding.tool, finding.field]);
}

/**
 * The messages a case expects, none when it gives none. A pattern matches in
 * place of a string, so a case with findings and no says fails.
 */
function messages(says: readonly (string | RegExp)[] = []): unknown[] {
  return says.map((each) => (typeof each === "string" ? each : expect.stringMatching(each)));
}

/** Every finding has the rule's level, the six fields, and a message and fix that are sentences. */
function expectShape(findings: readonly Finding[]): void {
  for (const finding of findings) {
    expect(Object.keys(finding).sort(byText)).toEqual(["field", "fix", "level", "message", "rule", "tool"]);
    expect(finding.level).toBe(LINT_RULES[finding.rule].level);
    expect(finding.message).toMatch(/\S\.$/);
    expect(finding.fix).toMatch(/\S\.$/);
  }
}

// ── Cases ────────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  folder: ServerFolder;
  context?: LintContext;
  found: Found[];
  /**
   * Each finding's message, in order. A case that finds nothing leaves it out.
   * A pattern stands in for a message that holds a measured token count.
   */
  says?: (string | RegExp)[];
}

const LONG_KEY = `list_${"a".repeat(55)}`;
const properties = (count: number): Record<string, unknown> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, { type: "string" }]));
const states = (count: number): string[] => Array.from({ length: count }, (_, index) => `s${index}`);

const ITEMS_RESPONSE = { status: "200", media_type: "application/json", wrap: "items" };
const ITEMS_OUTPUT = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } },
};
const branch = (property: string, tag?: string): Record<string, unknown> => ({
  type: "object",
  properties: { ...(tag === undefined ? {} : { kind: { const: tag } }), [property]: { type: "string" } },
});
const ANY = { type: "object", properties: { "@type": { type: "string" }, value: { type: "string" } } };

const openapi = (entries: Record<string, Record<string, unknown>>, offered: UpstreamTool[]): ServerFolder =>
  folder({ server: server(definitionServer("openapi")), tools: tools(entries), offered });
const graphql = (entries: Record<string, Record<string, unknown>>, offered: UpstreamTool[]): ServerFolder =>
  folder({ server: server(definitionServer("graphql")), tools: tools(entries), offered });
const grpc = (entries: Record<string, Record<string, unknown>>, offered: UpstreamTool[]): ServerFolder =>
  folder({ server: server(definitionServer("grpc")), tools: tools(entries), offered });

const POST_ENTRY = "acme.ledger.v1.Ledger/PostEntry";
const LIST_ENTRIES = "acme.ledger.v1.Ledger/ListEntries";

const CASES: Case[] = [
  // Every source.
  { name: "a clean remote folder", folder: issues(), found: [] },
  {
    name: "missing_classification: an entry with no risk",
    folder: folder({
      tools: rawTools({ list_issues: { side_effect: "read", egress: "third_party" } }),
      offered: [mcpTool("list_issues")],
    }),
    found: [["missing_classification", "list_issues", "risk"]],
    says: ["list_issues has no risk, and Oxagen decides each call from risk, side_effect, and egress."],
  },
  {
    name: "tool_not_offered: a selector the source does not read",
    folder: issues({ ...READ, operation: "listIssues" }),
    found: [["tool_not_offered", "list_issues", "operation"]],
    says: ["list_issues sets operation, which a remote source does not read, so the entry selects no tool."],
  },
  {
    name: "tool_not_offered: an OpenAPI entry with no operation",
    folder: openapi({ list_charges: READ }, [httpTool("listCharges")]),
    found: [["tool_not_offered", "list_charges", "operation"]],
    says: ["list_charges does not say which operation it imports."],
  },
  {
    name: "tool_not_offered: a tool the source no longer offers",
    folder: folder({ tools: tools({ list_issues: READ }), offered: [] }),
    found: [["tool_not_offered", "list_issues", "upstream"]],
    says: ["list_issues imports tool list_issues, and the source no longer offers it."],
  },
  {
    name: "no_description: neither tools.toml nor the source describes the tool",
    folder: issues(READ, { description: undefined }),
    found: [["no_description", "list_issues", "description"]],
    says: ["list_issues has no description, and the model picks a tool by its description."],
  },
  {
    name: "invalid_name: a key that is not a tool key",
    folder: folder({
      tools: rawTools({ "List-Issues": { ...READ, upstream: "list_issues" } }),
      offered: [mcpTool("list_issues")],
    }),
    found: [["invalid_name", "List-Issues", "name"]],
    says: ['"List-Issues" is not a tool key, so model APIs would reject acme__List-Issues.'],
  },
  {
    name: "invalid_name: a key search mode serves itself",
    folder: folder({
      server: server({ exposure: { mode: "search" } }),
      tools: tools({ search: { ...READ, upstream: "search_issues" } }),
      offered: [mcpTool("search_issues")],
    }),
    found: [["invalid_name", "search", "name"]],
    says: ["acme__search names two tools, because search mode serves its own acme__search."],
  },
  {
    name: "invalid_name: a full name over 64 characters",
    folder: folder({ tools: tools({ [LONG_KEY]: READ }), offered: [mcpTool(LONG_KEY)] }),
    found: [["invalid_name", LONG_KEY, "name"]],
    says: [`acme__${LONG_KEY} is 66 characters, and model APIs reject a tool name over 64.`],
  },
  {
    name: "invalid_name: a server name that breaks every tool name",
    folder: folder({ server: { ...server(), name: "Acme" }, tools: tools({ list_issues: READ }), offered: [mcpTool("list_issues")] }),
    found: [["invalid_name", undefined, "name"]],
    says: ['The server name "Acme" breaks every tool name, and model APIs reject a tool name that breaks the pattern.'],
  },
  {
    name: "unknown_credential: a credential the organization does not have",
    folder: issues(),
    context: context({ credentials: new Set() }),
    found: [["unknown_credential", undefined, "auth.credential"]],
    says: ["auth.credential names oxagen:credential/acme, and the organization has no credential by that name, so every call would fail."],
  },
  {
    name: "long_description: an own description over 1,024 characters",
    folder: folder({
      tools: rawTools({ list_issues: { ...READ, description: "a".repeat(1025) } }),
      offered: [mcpTool("list_issues")],
    }),
    found: [["long_description", "list_issues", "description"]],
    says: ["list_issues's description is 1,025 characters, over the 1,024 a description may be, and every request pays for it."],
  },
  {
    name: "long_description: a source description import cut",
    folder: issues(READ, { description: "a".repeat(1024) }),
    found: [["long_description", "list_issues", "description"]],
    says: ["The source's description of list_issues is 1,024 characters, at the 1,024 import cuts a description to, and every request pays for it."],
  },
  {
    name: "long_description: an own description of exactly 1,024 characters",
    folder: issues({ ...READ, description: "a".repeat(1024) }),
    found: [],
  },
  {
    name: "many_inputs: 21 inputs",
    folder: issues(READ, { inputSchema: { type: "object", properties: properties(21) } }),
    found: [["many_inputs", "list_issues", "inputSchema.properties"]],
    says: ["list_issues takes 21 inputs, and models fill a form of more than 20 poorly."],
  },
  {
    name: "many_inputs: 21 inputs with one hidden",
    folder: issues({ ...READ, hide: ["p20"] }, { inputSchema: { type: "object", properties: properties(21) } }),
    found: [],
  },
  {
    name: "large_enum: an enum of 51 values",
    folder: issues(READ, { inputSchema: { type: "object", properties: { state: { type: "string", enum: states(51) } } } }),
    found: [["large_enum", "list_issues", "inputSchema.properties.state.enum"]],
    says: ["inputSchema.properties.state lists 51 values, and every request pays for each one."],
  },
  {
    name: "large_enum: an enum of 50 values",
    folder: issues(READ, { inputSchema: { type: "object", properties: { state: { type: "string", enum: states(50) } } } }),
    found: [],
  },
  {
    name: "over_definition_budget: direct mode past the budget",
    folder: folder({
      server: server({ exposure: { mode: "direct", definition_budget: 1 } }),
      tools: tools({ list_issues: READ }),
      offered: [mcpTool("list_issues")],
    }),
    found: [["over_definition_budget", undefined, "exposure.mode"]],
    says: [/^The one imported tool costs about [\d,]+ tokens on every request, over the definition_budget of 1\.$/],
  },
  {
    name: "over_definition_budget: search mode past the budget",
    folder: folder({
      server: server({ exposure: { mode: "search", definition_budget: 1 } }),
      tools: tools({ list_issues: READ }),
      offered: [mcpTool("list_issues")],
    }),
    found: [],
  },
  {
    name: "irreversible_suggestion_unreviewed: an irreversible suggestion accepted unchanged",
    folder: folder({ tools: tools({ delete_issue: IRREVERSIBLE }), offered: [mcpTool("delete_issue")] }),
    context: context({ accepted_unchanged: new Set(["delete_issue"]) }),
    found: [["irreversible_suggestion_unreviewed", "delete_issue", "side_effect"]],
    says: ["delete_issue is irreversible, and its suggested classification was accepted without a change."],
  },
  {
    name: "irreversible_suggestion_unreviewed: a read suggestion accepted unchanged",
    folder: issues(),
    context: context({ accepted_unchanged: new Set(["list_issues"]) }),
    found: [],
  },

  // OpenAPI.
  {
    name: "no_output_schema: an operation with no JSON response schema",
    folder: openapi({ create_refund: { ...READ, operation: "createRefund" } }, [httpTool("createRefund", { outputSchema: undefined })]),
    found: [["no_output_schema", "create_refund", "outputSchema"]],
    says: ["create_refund has no JSON schema for its 2xx response, so the model gets its result as text only."],
  },
  {
    name: "no_output_schema: an MCP tool with no outputSchema",
    folder: issues(),
    found: [],
  },
  {
    name: "unbounded_array: an array response with no paging and no select",
    folder: openapi({ list_items: { ...READ, operation: "listItems" } }, [
      httpTool("listItems", {
        request: { kind: "http", operation: "listItems", method: "GET", path: "/items", parameters: [], response: ITEMS_RESPONSE },
        outputSchema: ITEMS_OUTPUT,
      }),
    ]),
    found: [["unbounded_array", "list_items", "select"]],
    says: ["list_items returns an array with no paging, so one result can fill the context."],
  },
  {
    name: "unbounded_array: an array response cut with select",
    folder: openapi({ list_items: { ...READ, operation: "listItems", select: ["items[].id"] } }, [
      httpTool("listItems", {
        request: { kind: "http", operation: "listItems", method: "GET", path: "/items", parameters: [], response: ITEMS_RESPONSE },
        outputSchema: ITEMS_OUTPUT,
      }),
    ]),
    found: [],
  },
  {
    name: "undiscriminated_one_of: branches a model cannot tell apart",
    folder: openapi({ create_payment: { ...READ, operation: "createPayment" } }, [
      httpTool("createPayment", {
        inputSchema: { type: "object", properties: { method: { oneOf: [branch("card"), branch("iban")] } } },
      }),
    ]),
    found: [["undiscriminated_one_of", "create_payment", "inputSchema.properties.method.oneOf"]],
    says: ["inputSchema.properties.method is a oneOf of 2 branches with no discriminator, so the model guesses the branch."],
  },
  {
    name: "undiscriminated_one_of: a oneOf with a discriminator",
    folder: openapi({ create_payment: { ...READ, operation: "createPayment" } }, [
      httpTool("createPayment", {
        inputSchema: {
          type: "object",
          properties: { method: { oneOf: [branch("card"), branch("iban")], discriminator: { propertyName: "kind" } } },
        },
      }),
    ]),
    found: [],
  },
  {
    name: "undiscriminated_one_of: branches told apart by a const",
    folder: openapi({ create_payment: { ...READ, operation: "createPayment" } }, [
      httpTool("createPayment", {
        inputSchema: { type: "object", properties: { method: { oneOf: [branch("card", "card"), branch("iban", "iban")] } } },
      }),
    ]),
    found: [],
  },

  // OpenAPI and GraphQL.
  {
    name: "deprecated_imported: a deprecated GraphQL field",
    folder: graphql({ issue: { ...READ, field: "Query.issue" } }, [graphqlTool("Query.issue", {}, { deprecated: true })]),
    found: [["deprecated_imported", "issue", "field"]],
    says: ["issue imports field Query.issue, which the source marks deprecated, so it may go away."],
  },
  {
    name: "deprecated_imported: a deprecated MCP tool",
    folder: issues(READ, { deprecated: true }),
    found: [],
  },

  // GraphQL.
  {
    name: "deep_selection: a selection four levels deep",
    folder: graphql({ issue: { ...READ, field: "Query.issue" } }, [
      graphqlTool("Query.issue", { selection: "{ issue { assignee { team { name } } } }" }),
    ]),
    found: [["deep_selection", "issue", "selection"]],
    says: ["issue's selection set nests 4 levels, and a set deeper than 3 makes large results and slow queries."],
  },
  {
    name: "deep_selection: a deep selection tools.toml replaces",
    folder: graphql({ issue: { ...READ, field: "Query.issue", selection: "{ id title }" } }, [
      graphqlTool("Query.issue", { selection: "{ issue { assignee { team { name } } } }" }),
    ]),
    found: [],
  },
  {
    name: "unpaged_list: a list field with no paging argument",
    folder: graphql({ issues: { ...READ, field: "Query.issues" } }, [graphqlTool("Query.issues", {}, { outputSchema: ITEMS_OUTPUT })]),
    found: [["unpaged_list", "issues", "outputSchema.properties.items"]],
    says: ["issues returns a list, and field Query.issues takes no paging argument, so one result can fill the context."],
  },
  {
    name: "unpaged_list: a list field that takes first",
    folder: graphql({ issues: { ...READ, field: "Query.issues" } }, [
      graphqlTool(
        "Query.issues",
        { arguments: [{ name: "first", type: "Int", property: "first" }] },
        { inputSchema: { type: "object", properties: { first: { type: "integer" } } }, outputSchema: ITEMS_OUTPUT },
      ),
    ]),
    found: [],
  },

  // gRPC.
  {
    name: "any_field: an Any in the input",
    folder: grpc({ post_entry: { ...READ, method: POST_ENTRY } }, [
      grpcTool(POST_ENTRY, {}, { inputSchema: { type: "object", properties: { detail: ANY } } }),
    ]),
    found: [["any_field", "post_entry", "inputSchema.properties.detail"]],
    says: ["inputSchema.properties.detail is a google.protobuf.Any, whose type is known only at run time, so the model cannot tell what it holds."],
  },
  {
    name: "any_field: an Any in the output",
    folder: grpc({ post_entry: { ...READ, method: POST_ENTRY } }, [
      grpcTool(POST_ENTRY, {}, { outputSchema: { type: "object", properties: { detail: ANY } } }),
    ]),
    found: [["any_field", "post_entry", "outputSchema.properties.detail"]],
    says: ["outputSchema.properties.detail is a google.protobuf.Any, whose type is known only at run time, so the model cannot tell what it holds."],
  },
  {
    name: "any_field: an @type property on an MCP tool",
    folder: issues(READ, { inputSchema: { type: "object", properties: { detail: ANY } } }),
    found: [],
  },
  {
    name: "unbounded_stream: a server stream with no max_items",
    folder: grpc({ list_entries: { ...READ, method: LIST_ENTRIES } }, [grpcTool(LIST_ENTRIES, { streaming: "server" })]),
    found: [["unbounded_stream", "list_entries", "max_items"]],
    says: [`list_entries imports server-streaming method ${LIST_ENTRIES} without max_items, so a stream that never ends runs to its deadline on every call.`],
  },
  {
    name: "unbounded_stream: a server stream capped by max_items",
    folder: grpc({ list_entries: { ...READ, method: LIST_ENTRIES, max_items: 100 } }, [grpcTool(LIST_ENTRIES, { streaming: "server" })]),
    found: [],
  },
  {
    name: "no_idempotency_level: a method with no idempotency_level",
    folder: grpc({ post_entry: { ...READ, method: POST_ENTRY } }, [grpcTool(POST_ENTRY, { idempotency_level: "IDEMPOTENCY_UNKNOWN" })]),
    found: [["no_idempotency_level", "post_entry", "method"]],
    says: [`${POST_ENTRY} sets no idempotency_level, so the suggestion falls back to write and high.`],
  },

  // Local.
  {
    name: "local_without_machines: a local server with no machine group",
    folder: folder({ server: mcpServerSchema.parse(LOCAL), tools: tools({ list_issues: READ }), offered: [mcpTool("list_issues")] }),
    found: [["local_without_machines", undefined, "source.machines"]],
    says: ["The server names no machine group, so it runs nowhere."],
  },
  {
    name: "local_without_machines: a local server on dev-laptops",
    folder: folder({
      server: mcpServerSchema.parse({ ...LOCAL, source: { ...LOCAL.source, machines: ["dev-laptops"] } }),
      tools: tools({ list_issues: READ }),
      offered: [mcpTool("list_issues")],
    }),
    found: [],
  },
];

describe("lint's tool checks", () => {
  it.each(CASES)("$name", ({ folder: value, context: given, found: expected, says }) => {
    const findings = lint(value, given ?? context());
    expect(found(findings)).toStrictEqual(expected);
    expect(findings.map((finding) => finding.message)).toStrictEqual(messages(says));
    expectShape(findings);
  });

  it("orders errors, then warnings, then infos", () => {
    const value = folder({
      server: server(definitionServer("openapi")),
      tools: rawTools({
        refund: { ...IRREVERSIBLE, operation: "createRefund" },
        list: { ...READ, operation: "listItems" },
        broken: { side_effect: "read", egress: "third_party", operation: "getItem" },
      }),
      offered: [httpTool("createRefund"), httpTool("listItems", { outputSchema: undefined }), httpTool("getItem")],
    });
    const findings = lint(value, context({ accepted_unchanged: new Set(["refund"]) }));
    expect(found(findings)).toStrictEqual([
      ["missing_classification", "broken", "risk"],
      ["no_output_schema", "list", "outputSchema"],
      ["irreversible_suggestion_unreviewed", "refund", "side_effect"],
    ]);
  });

  it("names the room left when a full name runs long", () => {
    const [finding] = lint(folder({ tools: tools({ [LONG_KEY]: READ }), offered: [mcpTool(LONG_KEY)] }), context());
    expect(finding?.fix).toBe(`Rename [tools.${LONG_KEY}] to at most 58 characters.`);
  });

  it("says what search mode lists in place of the imported tools", () => {
    const value = folder({
      server: server({ exposure: { mode: "direct", definition_budget: 1 } }),
      tools: tools({ list_issues: READ }),
      offered: [mcpTool("list_issues")],
    });
    const [finding] = lint(value, context());
    expect(finding?.message).toMatch(
      /^The one imported tool costs about [\d,]+ tokens on every request, over the definition_budget of 1\.$/,
    );
    expect(finding?.fix).toBe(
      'Set exposure.mode = "search" in server.toml, so each request lists 3 tools (search, describe, and call) in place of 1.',
    );
  });

  it("hides an Any input, and selects around an Any output", () => {
    const input = lint(
      grpc({ post_entry: { ...READ, method: POST_ENTRY } }, [
        grpcTool(POST_ENTRY, {}, { inputSchema: { type: "object", properties: { detail: ANY } } }),
      ]),
      context(),
    );
    const output = lint(
      grpc({ post_entry: { ...READ, method: POST_ENTRY } }, [
        grpcTool(POST_ENTRY, {}, { outputSchema: { type: "object", properties: { detail: ANY } } }),
      ]),
      context(),
    );
    expect(input.map((finding) => finding.fix)).toStrictEqual(["Hide the input or fix its value in [tools.post_entry]."]);
    expect(output.map((finding) => finding.fix)).toStrictEqual([
      "Leave the field out of the result with select in [tools.post_entry].",
    ]);
  });
});

// ── Import fixtures ──────────────────────────────────────────────────────────

interface FixtureCase {
  name: string;
  folder: ServerFolder;
  /** The rules the case checks. Other findings on the fixture are left to their own cases. */
  rules: LintRule[];
  found: Found[];
  /** Each finding's message, in order. A case that finds nothing leaves it out. */
  says?: string[];
}

const FIXTURE_CASES: FixtureCase[] = [
  {
    name: "deprecated_imported: openapi-3.0's listPetPhotos",
    folder: imported("openapi", "expected/openapi/openapi-3.0.json", {
      list_pet_photos: { ...READ, operation: "listPetPhotos" },
    }),
    rules: ["deprecated_imported"],
    found: [["deprecated_imported", "list_pet_photos", "operation"]],
    says: ["list_pet_photos imports operation listPetPhotos, which the source marks deprecated, so it may go away."],
  },
  {
    name: "unbounded_array: multi-file's listItems",
    folder: imported("openapi", "expected/openapi/multi-file.json", { list_items: { ...READ, operation: "listItems" } }),
    rules: ["unbounded_array"],
    found: [["unbounded_array", "list_items", "select"]],
    says: ["list_items returns an array with no paging, so one result can fill the context."],
  },
  {
    name: "recursive_schema: the Category notes, and none for get_employee, which tools.toml leaves out",
    folder: imported("openapi", "expected/openapi/recursive.json", {
      get_category: { ...READ, operation: "getCategory" },
      create_tree: { ...READ, operation: "createTree" },
    }),
    rules: ["recursive_schema"],
    found: [
      ["recursive_schema", "get_category", undefined],
      ["recursive_schema", "create_tree", undefined],
    ],
    says: [
      "get_category holds Category, a schema that refers to itself, and import cut it at depth 4.",
      "create_tree holds Category, a schema that refers to itself, and import cut it at depth 4.",
    ],
  },
  {
    name: "deep_selection and unpaged_list: the GraphQL fixture's generated selections and paged lists",
    folder: imported("graphql", "expected/graphql/upstream.json", {
      issue: { ...READ, field: "Query.issue" },
      issues: { ...READ, field: "Query.issues" },
      search: { ...READ, field: "Query.search" },
    }),
    rules: ["deep_selection", "unpaged_list"],
    found: [],
  },
];

describe("lint on what the importers return", () => {
  it.each(FIXTURE_CASES)("$name", ({ folder: value, rules, found: expected, says }) => {
    const findings = lint(value, context()).filter((finding) => rules.includes(finding.rule));
    expect(found(findings)).toStrictEqual(expected);
    expect(findings.map((finding) => finding.message)).toStrictEqual(messages(says));
    expectShape(findings);
  });
});

describe("lint's coverage of the Tool checks table", () => {
  it("trips every rule outside the registry rows in a case above that states its message", () => {
    const tripped = new Set([...CASES, ...FIXTURE_CASES].flatMap((each) => each.found.map(([rule]) => rule)));
    const rules = Object.entries(LINT_RULES)
      .filter(([, rule]) => JSON.stringify(rule.sources) !== JSON.stringify(["registry"]))
      .map(([name]) => name);
    expect([...tripped].sort(byText)).toStrictEqual(rules.sort(byText));
  });
});

// ── The fixture folders ──────────────────────────────────────────────────────

describe("lint on the fixture folders", () => {
  it.each(SERVERS)("returns [] for %s", (name) => {
    expect(lint(fixture(name), context())).toStrictEqual([]);
  });

  it("reports billing's create_refund when its irreversible suggestion was accepted unchanged", () => {
    const findings = lint(fixture("billing"), context({ accepted_unchanged: new Set(["create_refund"]) }));
    expect(found(findings)).toStrictEqual([["irreversible_suggestion_unreviewed", "create_refund", "side_effect"]]);
    expectShape(findings);
  });

  it("reports billing's auth.credential when the organization has no credentials", () => {
    const findings = lint(fixture("billing"), context({ credentials: new Set() }));
    expect(found(findings)).toStrictEqual([["unknown_credential", undefined, "auth.credential"]]);
    expect(findings[0]?.fix).toBe(
      "Add oxagen:credential/billing-oauth-client in Oxagen, or set auth.credential to a credential the organization has.",
    );
  });

  it("reports stripe's live environment when only the test credential exists", () => {
    const findings = lint(fixture("stripe"), context({ credentials: new Set(["oxagen:credential/stripe-test"]) }));
    expect(found(findings)).toStrictEqual([["unknown_credential", undefined, "environments.live.credential"]]);
  });

  // lint counts definition tokens without compiling (shape.ts). This holds its
  // count to compile's on each fixture, one token either side of the budget.
  it.each(SERVERS)("counts %s's definition tokens as compile does", (name) => {
    const value = fixture(name);
    const pinned = value.lock?.source;
    const compiled = compile({
      server: value.server,
      tools: value.tools,
      upstream: [...value.offered],
      security_schemes: pinned?.type === "openapi" ? (pinned.security_schemes ?? {}) : {},
      descriptor_set: undefined,
    });
    const definitions = compiled.tokens.definitions;
    const budget = (limit: number): ServerFolder => ({
      ...value,
      server: { ...value.server, exposure: { mode: "direct", definition_budget: limit } },
    });

    expect(lint(budget(definitions), context())).toStrictEqual([]);
    const over = lint(budget(definitions - 1), context());
    expect(found(over)).toStrictEqual([["over_definition_budget", undefined, "exposure.mode"]]);
    expect(over[0]?.message).toMatch(/^The 2 imported tools cost about [\d,]+ tokens on every request/);
    expect(over[0]?.fix).toMatch(/in place of 2\.$/);
  });
});
