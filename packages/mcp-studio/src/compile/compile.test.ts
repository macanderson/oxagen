// compile: the fixtures compile to M0's expected manifests byte for byte, and
// every reason a server does not compile is reported with its tool and field.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_DEFINITION_BUDGET } from "@oxagen/oxagen/steering-repo/tokens";
import { definitionTokens } from "../contract/hashes";
import { formatJson } from "../contract/json";
import { mcpLockSchema, type McpLock, type McpToolsLock } from "../contract/lock";
import { toolManifestSchema } from "../contract/manifest";
import { mcpToolsListResultSchema } from "../contract/mcp-tool";
import { parseLock, parseServerToml, parseToolsToml, type ReadResult } from "../contract/parse";
import { registryEntrySchema } from "../contract/registry-entry";
import { mcpServerSchema, type McpServer } from "../contract/server";
import { mcpToolsSchema, type McpTools } from "../contract/tools";
import { lock, registryLockSource } from "../lock";
import { upstreamFromMcpTool } from "../model/from-mcp";
import type { SecurityScheme } from "../model/security-scheme";
import { upstreamToolSchema, type UpstreamTool } from "../model/upstream-tool";
import { compile, CompileError, toManifestServer, type CompileInput, type CompileIssue } from "./index";

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SERVERS = ["billing", "stripe"] as const;
type FixtureServer = (typeof SERVERS)[number];

function pinnedLock(name: FixtureServer): McpToolsLock {
  return ok(parseLock(text(`servers/${name}/tools.lock.json`)));
}

/** stripe's pinned lock as the MCP lock it is, so its tools can be spread and replaced. */
function stripePin(): McpLock {
  return mcpLockSchema.parse(pinnedLock("stripe"));
}

/** A fixture folder's compile input: stripe's tools/list, or the upstream M1 returns for billing. */
function fixtureInput(name: FixtureServer): CompileInput {
  const pinned = pinnedLock(name).source;
  return {
    server: ok(parseServerToml(text(`servers/${name}/server.toml`))),
    tools: ok(parseToolsToml(text(`servers/${name}/tools.toml`))),
    upstream:
      name === "stripe"
        ? mcpToolsListResultSchema.parse(json("sources/stripe/tools-list.json")).tools.map(upstreamFromMcpTool)
        : upstreamToolSchema.array().parse(json("expected/billing/upstream.json")),
    security_schemes: pinned.type === "openapi" ? (pinned.security_schemes ?? {}) : {},
    descriptor_set: undefined,
  };
}

describe("compile with the fixtures", () => {
  it.each(SERVERS)("locks %s to its tools.lock.json and its manifest.json, byte for byte", (name) => {
    const compiled = compile(fixtureInput(name));
    const locked = lock({ compiled, source: pinnedLock(name).source, previous: undefined });
    expect(formatJson(locked)).toBe(text(`servers/${name}/tools.lock.json`));
    expect(formatJson(toManifestServer(compiled, locked))).toBe(text(`expected/${name}/manifest.json`));
  });

  it("writes expected/tool-manifest.json, byte for byte", () => {
    const servers = SERVERS.map((name) => {
      const compiled = compile(fixtureInput(name));
      return toManifestServer(compiled, lock({ compiled, source: pinnedLock(name).source, previous: undefined }));
    });
    const manifest = toolManifestSchema.parse({ schema: "tool-manifest/v1", servers });
    expect(formatJson(manifest)).toBe(text("expected/tool-manifest.json"));
  });

  it("keeps the upstream each tool came from, for lock to pin", () => {
    const input = fixtureInput("stripe");
    const compiled = compile(input);
    expect(compiled.tools.create_refund?.upstream).toBe(input.upstream.find((tool) => tool.name === "create_refund"));
  });
});

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

/** A parsed server.toml: the Acme remote server with fields replaced. */
function server(fields: Record<string, unknown> = {}): McpServer {
  return mcpServerSchema.parse({ ...REMOTE, ...fields });
}

/** A parsed tools.toml with these entries. */
function tools(entries: Record<string, Record<string, unknown>>): McpTools {
  return mcpToolsSchema.parse({ schema: "mcp-tools/v1", tools: entries });
}

function upstreamTool(fields: Record<string, unknown>): UpstreamTool {
  return upstreamToolSchema.parse({ inputSchema: { type: "object" }, ...fields });
}

function mcpTool(name: string, fields: Record<string, unknown> = {}): UpstreamTool {
  return upstreamTool({ name, request: { kind: "mcp", tool: name }, ...fields });
}

function httpTool(operation: string, fields: Record<string, unknown> = {}): UpstreamTool {
  return upstreamTool({
    name: operation,
    request: { kind: "http", operation, method: "POST", path: "/refunds", parameters: [] },
    ...fields,
  });
}

function graphqlTool(field: string, fields: Record<string, unknown> = {}): UpstreamTool {
  return upstreamTool({
    name: field,
    request: { kind: "graphql", operation_type: "query", field, arguments: [], selection: "{ id }" },
    ...fields,
  });
}

function grpcTool(method: string, streaming: "unary" | "server"): UpstreamTool {
  return upstreamTool({
    name: method.split("/")[1],
    request: {
      kind: "grpc",
      method,
      streaming,
      idempotency_level: "NO_SIDE_EFFECTS",
      request_type: "acme.ledger.v1.Request",
      response_type: "acme.ledger.v1.Response",
    },
  });
}

function input(fields: Partial<CompileInput> & Pick<CompileInput, "tools" | "upstream">): CompileInput {
  return {
    server: fields.server ?? server(),
    tools: fields.tools,
    upstream: fields.upstream,
    security_schemes: fields.security_schemes ?? {},
    descriptor_set: fields.descriptor_set,
  };
}

/** The issues compile throws for an input that must not compile. */
function issues(value: CompileInput): CompileIssue[] {
  try {
    compile(value);
  } catch (error) {
    if (error instanceof CompileError) return [...error.issues];
    throw error;
  }
  throw new Error("compile returned a server");
}

// ── Upstream ─────────────────────────────────────────────────────────────────

describe("compile finds each tool's upstream", () => {
  it("by the tool key, or by upstream when the MCP name is no tool key", () => {
    const compiled = compile(
      input({
        tools: tools({ create_issue: READ, search_code: { ...READ, upstream: "search-code" } }),
        upstream: [mcpTool("create_issue"), mcpTool("search-code")],
      }),
    );
    expect(compiled.tools.create_issue?.request).toStrictEqual({ kind: "mcp", tool: "create_issue" });
    expect(compiled.tools.search_code?.request).toStrictEqual({ kind: "mcp", tool: "search-code" });
    expect(compiled.tools.search_code?.name).toBe("acme__search_code");
    expect(compiled.tools.search_code?.definition.name).toBe("acme__search_code");
  });

  it("refuses a selector another source type uses", () => {
    expect(
      issues(input({ tools: tools({ create_issue: { ...READ, operation: "createIssue" } }), upstream: [] })),
    ).toStrictEqual([
      {
        tool: "create_issue",
        field: "operation",
        message: "create_issue: operation does not apply to a remote source. Use upstream.",
      },
    ]);
  });

  it("needs the selector its source type uses", () => {
    expect(
      issues(
        input({
          server: server(definitionServer("openapi")),
          tools: tools({ create_refund: IRREVERSIBLE }),
          upstream: [httpTool("createRefund")],
        }),
      ),
    ).toStrictEqual([
      { tool: "create_refund", field: "operation", message: "create_refund: an openapi source needs operation." },
    ]);
  });

  it("refuses an upstream the source does not offer, or offers under another kind", () => {
    expect(
      issues(
        input({
          tools: tools({ create_issue: READ, create_refund: { ...READ, upstream: "createRefund" } }),
          upstream: [httpTool("createRefund")],
        }),
      ),
    ).toStrictEqual([
      { tool: "create_issue", field: "upstream", message: "create_issue: the source offers no upstream create_issue." },
      { tool: "create_refund", field: "upstream", message: "create_refund: the source offers no upstream createRefund." },
    ]);
  });
});

// ── Input shaping ────────────────────────────────────────────────────────────

const REFUND_INPUT = {
  type: "object",
  properties: {
    charge: { type: "string" },
    amount: { type: "integer" },
    reason: { type: "string" },
    source: { type: "string" },
    idempotency_key: { type: "string" },
    key: { type: "string" },
  },
  required: ["charge", "amount", "source", "idempotency_key"],
};

const refund = httpTool("createRefund", {
  inputSchema: REFUND_INPUT,
  request: {
    kind: "http",
    operation: "createRefund",
    method: "POST",
    path: "/refunds",
    parameters: [
      { name: "Idempotency-Key", in: "header", property: "idempotency_key", required: true },
      { name: "Idempotency-Key", in: "query", property: "key", required: false },
    ],
  },
});

function compileRefund(entry: Record<string, unknown>): CompileInput {
  return input({
    server: server(definitionServer("openapi")),
    tools: tools({ refund: { ...IRREVERSIBLE, operation: "createRefund", ...entry } }),
    upstream: [refund],
  });
}

describe("compile shapes the input", () => {
  it("applies hide, fixed, the idempotency header, defaults, and rename", () => {
    const compiled = compile(
      compileRefund({
        hide: ["reason"],
        fixed: { source: "oxagen" },
        defaults: { amount: 100 },
        rename: { charge: "charge_id" },
        idempotency_header: "idempotency-key",
      }),
    );
    expect(compiled.tools.refund?.definition.inputSchema).toStrictEqual({
      type: "object",
      properties: {
        charge_id: { type: "string" },
        amount: { type: "integer", default: 100 },
        key: { type: "string" },
      },
      required: ["charge_id"],
    });
    expect(compiled.tools.refund?.shaping.idempotency_header).toBe("idempotency-key");
    expect(refund.inputSchema).toStrictEqual(REFUND_INPUT);
  });

  it("returns the upstream schema itself when nothing shapes it", () => {
    const compiled = compile(compileRefund({}));
    expect(compiled.tools.refund?.definition.inputSchema).toBe(refund.inputSchema);
    expect(compiled.tools.refund?.shaping).toStrictEqual({
      hide: [],
      fixed: {},
      defaults: {},
      rename: {},
      select: [],
      redact: [],
      max_result_bytes: 65_536,
      deadline_ms: 30_000,
    });
  });

  it("drops required when no required input is left", () => {
    const tool = mcpTool("create_issue", {
      inputSchema: { type: "object", properties: { title: { type: "string" }, flag: true }, required: ["title"] },
    });
    const compiled = compile(
      input({ tools: tools({ create_issue: { ...READ, hide: ["title"], defaults: { flag: false } } }), upstream: [tool] }),
    );
    expect(compiled.tools.create_issue?.definition.inputSchema).toStrictEqual({
      type: "object",
      properties: { flag: { default: false } },
    });
  });

  it("reports every input it cannot shape", () => {
    expect(
      issues(
        compileRefund({
          hide: ["reason", "ghost"],
          fixed: { phantom: 1 },
          defaults: { reason: "duplicate", nothing: 1 },
          rename: { reason: "why", charge: "amount" },
        }),
      ),
    ).toStrictEqual([
      { tool: "refund", field: "hide", message: "refund: hide names ghost, which is not an input of createRefund." },
      { tool: "refund", field: "fixed", message: "refund: fixed names phantom, which is not an input of createRefund." },
      {
        tool: "refund",
        field: "defaults",
        message: "refund: defaults names reason, which hide or fixed takes out of the input.",
      },
      {
        tool: "refund",
        field: "defaults",
        message: "refund: defaults names nothing, which is not an input of createRefund.",
      },
      {
        tool: "refund",
        field: "rename",
        message: "refund: rename names reason, which hide or fixed takes out of the input.",
      },
      { tool: "refund", field: "rename", message: "refund: rename gives charge and amount one name, amount." },
    ]);
  });
});

// ── Result shaping ───────────────────────────────────────────────────────────

const LIST_OUTPUT = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, amount: { type: "integer" }, secret: { type: "string" } },
        required: ["id", "secret"],
      },
    },
    has_more: { type: "boolean" },
    meta: { type: "object", description: "Free-form." },
    tags: { type: "array" },
    links: true,
    internal: { type: "string" },
  },
  required: ["data", "internal"],
};

describe("compile keeps the selected result paths", () => {
  it("cuts the outputSchema to the paths select names", () => {
    const tool = mcpTool("list_charges", { outputSchema: LIST_OUTPUT });
    const select = ["data[].id", "data[].amount", "has_more", "meta.page", "tags[].name", "links.self", "missing"];
    const compiled = compile(input({ tools: tools({ list_charges: { ...READ, select } }), upstream: [tool] }));
    expect(compiled.tools.list_charges?.definition.outputSchema).toStrictEqual({
      type: "object",
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, amount: { type: "integer" } },
            required: ["id"],
          },
        },
        has_more: { type: "boolean" },
        meta: { type: "object", description: "Free-form." },
        tags: { type: "array" },
        links: true,
      },
      required: ["data"],
    });
    expect(compiled.tools.list_charges?.shaping.select).toStrictEqual(select);
  });

  it("keeps a whole field when select names it and a path inside it", () => {
    const tool = mcpTool("list_charges", { outputSchema: LIST_OUTPUT });
    const compiled = compile(
      input({ tools: tools({ list_charges: { ...READ, select: ["data[].id", "data"] } }), upstream: [tool] }),
    );
    expect(compiled.tools.list_charges?.definition.outputSchema).toStrictEqual({
      type: "object",
      properties: { data: LIST_OUTPUT.properties.data },
      required: ["data"],
    });
  });

  it("leaves the outputSchema whole with no select, and absent when the upstream has none", () => {
    const compiled = compile(
      input({
        tools: tools({ list_charges: READ, create_issue: { ...READ, select: ["id"] } }),
        upstream: [mcpTool("list_charges", { outputSchema: LIST_OUTPUT }), mcpTool("create_issue")],
      }),
    );
    expect(compiled.tools.list_charges?.definition.outputSchema).toStrictEqual(LIST_OUTPUT);
    expect(compiled.tools.create_issue?.definition).not.toHaveProperty("outputSchema");
  });
});

// ── Definition ───────────────────────────────────────────────────────────────

describe("compile builds each definition", () => {
  it("takes the title and description from the upstream, and tools.toml's description over it", () => {
    const compiled = compile(
      input({
        tools: tools({ create_issue: READ, close_issue: { ...IRREVERSIBLE, description: "Close one issue." } }),
        upstream: [
          mcpTool("create_issue", { title: "Create issue", description: "Opens an issue." }),
          mcpTool("close_issue", { description: "Closes an issue." }),
        ],
      }),
    );
    expect(compiled.tools.create_issue?.definition).toMatchObject({ title: "Create issue", description: "Opens an issue." });
    expect(compiled.tools.close_issue?.definition.description).toBe("Close one issue.");
    expect(compiled.tools.close_issue?.definition).not.toHaveProperty("title");
  });

  it("derives annotations from the classification, never from the upstream", () => {
    const hints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    const compiled = compile(
      input({
        tools: tools({ close_issue: IRREVERSIBLE }),
        upstream: [mcpTool("close_issue", { annotations: hints })],
      }),
    );
    expect(compiled.tools.close_issue?.definition.annotations).toStrictEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("carries the classification, the size and deadline caps, and deprecated", () => {
    const compiled = compile(
      input({
        tools: tools({
          close_issue: {
            ...IRREVERSIBLE,
            impacts: ["destroys_data"],
            data_classes: ["pii"],
            redact: ["author.email"],
            max_result_bytes: 2048,
          },
        }),
        upstream: [mcpTool("close_issue", { deprecated: true })],
      }),
    );
    const tool = compiled.tools.close_issue;
    expect(tool?.classification).toStrictEqual({
      risk: "high",
      side_effect: "irreversible",
      egress: "org_tenant",
      impacts: ["destroys_data"],
      measures: {},
      data_classes: ["pii"],
    });
    expect(tool?.shaping).toMatchObject({ redact: ["author.email"], max_result_bytes: 2048 });
    expect(tool?.deprecated).toBe(true);
    expect(tool?.tokens).toBe(definitionTokens(tool!.definition));
  });
});

// ── GraphQL ──────────────────────────────────────────────────────────────────

describe("compile applies a GraphQL selection", () => {
  const issue = graphqlTool("Query.issue");

  function withSelection(selection: string | undefined): CompileInput {
    const entry = selection === undefined ? { ...READ, field: "Query.issue" } : { ...READ, field: "Query.issue", selection };
    return input({ server: server(definitionServer("graphql")), tools: tools({ issue: entry }), upstream: [issue] });
  }

  it("sends tools.toml's selection in place of the generated one", () => {
    const selection = '{ id title author { login } labels(first: 5, after: "a\\"}b") { name } }';
    const compiled = compile(withSelection(selection));
    expect(compiled.tools.issue?.request).toStrictEqual({ ...issue.request, selection });
  });

  it("sends the generated selection when tools.toml names none", () => {
    expect(compile(withSelection(undefined)).tools.issue?.request).toBe(issue.request);
  });

  it.each([
    ["{ id", "selection has an unclosed {."],
    ["id }", "selection has an unmatched } at character 4."],
    ["{ id(x: 1 }", "selection has an unmatched } at character 11."],
    ["{ id )", "selection has an unmatched ) at character 6."],
    ['{ id(x: "open) }', "selection has a string with no closing quote."],
    ["{ }", "selection names no field."],
  ])("refuses %s", (selection, problem) => {
    expect(issues(withSelection(selection))).toStrictEqual([
      { tool: "issue", field: "selection", message: `issue: ${problem}` },
    ]);
  });
});

// ── Paging ───────────────────────────────────────────────────────────────────

describe("compile pages", () => {
  const paging = { style: "cursor", input: "cursor", next: "next_cursor", items: "data" };
  const listCharges = httpTool("listCharges", { paging });

  function paged(entry: Record<string, unknown>, upstream: UpstreamTool = listCharges): CompileInput {
    return input({
      server: server(definitionServer("openapi")),
      tools: tools({ list_charges: { ...READ, operation: "listCharges", ...entry } }),
      upstream: [upstream],
    });
  }

  it("by the style the upstream pages by, up to 10,000 items unless max_items says less", () => {
    const tool = compile(paged({ paginate: "cursor" })).tools.list_charges;
    expect(tool?.shaping).toMatchObject({ paginate: "cursor", max_items: 10_000 });
    expect(tool?.paging).toStrictEqual(paging);
    expect(compile(paged({ paginate: "cursor", max_items: 50 })).tools.list_charges?.shaping.max_items).toBe(50);
  });

  it("keeps the upstream's paging pattern when tools.toml does not page", () => {
    const tool = compile(paged({})).tools.list_charges;
    expect(tool?.paging).toStrictEqual(paging);
    expect(tool?.shaping).not.toHaveProperty("paginate");
    expect(tool?.shaping).not.toHaveProperty("max_items");
  });

  it("refuses a style the upstream cannot support", () => {
    expect(issues(paged({ paginate: "page" }))).toStrictEqual([
      { tool: "list_charges", field: "paginate", message: "list_charges: paginate is page, and listCharges pages by cursor." },
    ]);
    expect(issues(paged({ paginate: "cursor" }, httpTool("listCharges")))).toStrictEqual([
      {
        tool: "list_charges",
        field: "paginate",
        message: "list_charges: paginate is cursor, and listCharges has no paging pattern.",
      },
    ]);
  });
});

// ── gRPC ─────────────────────────────────────────────────────────────────────

describe("compile a gRPC server", () => {
  const stream = grpcTool("acme.ledger.v1.Ledger/ListEntries", "server");
  const unary = grpcTool("acme.ledger.v1.Ledger/PostEntry", "unary");

  function grpcInput(entries: Record<string, Record<string, unknown>>, descriptor: Uint8Array | undefined): CompileInput {
    return input({
      server: server(definitionServer("grpc")),
      tools: tools(entries),
      upstream: [stream, unary],
      descriptor_set: descriptor,
    });
  }

  it("caps a server stream, and carries the FileDescriptorSet in base64", () => {
    const compiled = compile(
      grpcInput(
        {
          list_entries: { ...READ, method: "acme.ledger.v1.Ledger/ListEntries" },
          few_entries: { ...READ, method: "acme.ledger.v1.Ledger/ListEntries", max_items: 20, deadline_ms: 5000 },
        },
        new Uint8Array([1, 2, 3]),
      ),
    );
    expect(compiled.tools.list_entries?.shaping.max_items).toBe(10_000);
    expect(compiled.tools.few_entries?.shaping).toMatchObject({ max_items: 20, deadline_ms: 5000 });
    expect(compiled.descriptor_set).toBe("AQID");
  });

  it("refuses max_items on a unary method, and a server with no FileDescriptorSet", () => {
    expect(
      issues(grpcInput({ post_entry: { ...IRREVERSIBLE, method: "acme.ledger.v1.Ledger/PostEntry", max_items: 5 } }, undefined)),
    ).toStrictEqual([
      {
        tool: "post_entry",
        field: "max_items",
        message: "post_entry: max_items caps auto paging or a gRPC server stream, and PostEntry has neither.",
      },
      {
        tool: undefined,
        field: "descriptor_set",
        message: "A gRPC server needs the FileDescriptorSet its import returned.",
      },
    ]);
  });

  it("carries no descriptor_set for any other source", () => {
    const compiled = compile(input({ tools: tools({}), upstream: [], descriptor_set: new Uint8Array([1]) }));
    expect(compiled).not.toHaveProperty("descriptor_set");
  });
});

// ── Names ────────────────────────────────────────────────────────────────────

describe("compile names each tool", () => {
  it("refuses a name over 64 characters", () => {
    const key = `k${"x".repeat(60)}`;
    expect(issues(input({ tools: tools({ [key]: READ }), upstream: [mcpTool(key)] }))).toStrictEqual([
      { tool: key, field: "name", message: `${key}: acme__${key} is 67 characters. A tool name is at most 64.` },
    ]);
  });

  it("refuses a key search mode reserves", () => {
    expect(
      issues(
        input({
          server: server({ exposure: { mode: "search" } }),
          tools: tools({ search: READ, call: READ }),
          upstream: [mcpTool("search"), mcpTool("call")],
        }),
      ),
    ).toStrictEqual([
      {
        tool: "search",
        field: "name",
        message: "search: acme__search names two tools. search is reserved when the exposure mode is search.",
      },
      {
        tool: "call",
        field: "name",
        message: "call: acme__call names two tools. call is reserved when the exposure mode is search.",
      },
    ]);
  });

  it("allows those keys in direct mode", () => {
    const compiled = compile(input({ tools: tools({ search: READ }), upstream: [mcpTool("search")] }));
    expect(compiled.tools.search?.name).toBe("acme__search");
  });
});

// ── Exposure ─────────────────────────────────────────────────────────────────

describe("compile a search-mode server", () => {
  function searchInput(entries: Record<string, Record<string, unknown>>): CompileInput {
    return input({
      server: server({ exposure: { mode: "search", definition_budget: 500 } }),
      tools: tools(entries),
      upstream: [mcpTool("list_issues"), mcpTool("delete_issue")],
    });
  }

  it("shows search, describe, and call, and keeps every imported tool behind them", () => {
    const compiled = compile(searchInput({ list_issues: READ, delete_issue: IRREVERSIBLE }));
    expect(Object.keys(compiled.tools)).toStrictEqual(["list_issues", "delete_issue"]);
    expect(compiled.search?.map((definition) => definition.name)).toStrictEqual([
      "acme__search",
      "acme__describe",
      "acme__call",
    ]);
    expect(compiled.search?.[0]?.description).toBe("Search the Acme tools you may call. Returns up to 10, one line each.");
    expect(compiled.exposure).toStrictEqual({ mode: "search", definition_budget: 500 });
  });

  it("counts every imported definition, and sends only the three", () => {
    const compiled = compile(searchInput({ list_issues: READ, delete_issue: IRREVERSIBLE }));
    const definitions = Object.values(compiled.tools).reduce((sum, tool) => sum + tool.tokens, 0);
    const request = (compiled.search ?? []).reduce((sum, definition) => sum + definitionTokens(definition), 0);
    expect(compiled.tokens).toStrictEqual({ definitions, request });
  });

  it("marks call destructive or open world when any tool behind it is", () => {
    const [, , mixed] = compile(searchInput({ list_issues: READ, delete_issue: IRREVERSIBLE })).search ?? [];
    expect(mixed?.annotations).toStrictEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    const [, , quiet] =
      compile(searchInput({ list_issues: { ...READ, egress: "org_tenant" } })).search ?? [];
    expect(quiet?.annotations).toStrictEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  it("sends every definition in direct mode, within the default budget", () => {
    const compiled = compile(input({ tools: tools({ list_issues: READ }), upstream: [mcpTool("list_issues")] }));
    expect(compiled.search).toBeNull();
    expect(compiled.tokens.request).toBe(compiled.tokens.definitions);
    expect(compiled.exposure.definition_budget).toBe(DEFAULT_SERVER_DEFINITION_BUDGET);
  });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe("compile resolves auth", () => {
  const none = tools({});

  it("applies a built-in scheme to every source but OpenAPI", () => {
    expect(compile(input({ tools: none, upstream: [] })).auth).toStrictEqual({
      mode: "service",
      scheme: "bearer",
      apply: { type: "http_bearer" },
    });
    const header = server({
      auth: { mode: "service", scheme: "header", header: "X-Api-Key", credential: "oxagen:credential/acme" },
    });
    expect(compile(input({ server: header, tools: none, upstream: [] })).auth?.apply).toStrictEqual({
      type: "api_key",
      in: "header",
      name: "X-Api-Key",
    });
  });

  it("applies the OpenAPI security scheme auth.scheme names", () => {
    const scheme: SecurityScheme = { type: "api_key", in: "header", name: "X-Acme-Key" };
    const openapi = server({
      ...definitionServer("openapi"),
      auth: { mode: "service", scheme: "acme_key", credential: "oxagen:credential/acme" },
    });
    const compiled = compile(input({ server: openapi, tools: none, upstream: [], security_schemes: { acme_key: scheme } }));
    expect(compiled.auth).toStrictEqual({ mode: "service", scheme: "acme_key", apply: scheme });
  });

  /** An OpenAPI server whose auth.scheme names a mutual TLS scheme, with these environments and this mode. */
  function mutualTls(
    environments: Record<string, Record<string, unknown>>,
    mode: "service" | "operator-oauth" = "service",
  ): CompileInput {
    const openapi = server({
      ...definitionServer("openapi"),
      auth: { mode, scheme: "mtls", credential: "oxagen:credential/acme" },
      environments,
    });
    return input({ server: openapi, tools: none, upstream: [], security_schemes: { mtls: { type: "mutual_tls" } } });
  }

  it("applies a mutual TLS scheme when every environment routes through a relay", () => {
    const compiled = compile(
      mutualTls({
        test: { sandbox: true, url: "https://test.acme.example/v1", network: "relay:acme-east" },
        live: { url: "https://api.acme.example/v1", network: "relay:acme-west" },
      }),
    );
    expect(compiled.auth).toStrictEqual({ mode: "service", scheme: "mtls", apply: { type: "mutual_tls" } });
  });

  it("refuses a mutual TLS scheme when one environment routes over cloud, and names that one", () => {
    expect(
      issues(
        mutualTls({
          test: { sandbox: true, url: "https://test.acme.example/v1", network: "relay:acme-east" },
          live: { url: "https://api.acme.example/v1", network: "cloud" },
        }),
      ),
    ).toStrictEqual([
      {
        tool: undefined,
        field: "auth.scheme",
        message:
          "auth.scheme mtls is mutual TLS, which only a relay that holds the client certificate can present. Environment live routes over cloud. Set each environment's network to relay:<name>.",
      },
    ]);
  });

  it("refuses a mutual TLS scheme when a relay environment's url is http, and names that environment", () => {
    expect(
      issues(
        mutualTls({
          test: { sandbox: true, url: "https://test.acme.example/v1", network: "relay:acme-east" },
          live: { url: "http://api.acme.internal/v1", network: "relay:acme-west" },
        }),
      ),
    ).toStrictEqual([
      {
        tool: undefined,
        field: "auth.scheme",
        message:
          "auth.scheme mtls is mutual TLS, which presents the client certificate in a TLS handshake. Environment live has no https url. Set each environment's url to an https:// endpoint.",
      },
    ]);
  });

  it("refuses a mutual TLS scheme in operator-oauth mode, even when every route is a relay", () => {
    expect(
      issues(
        mutualTls(
          {
            test: { sandbox: true, url: "https://test.acme.example/v1", network: "relay:acme-east" },
            live: { url: "https://api.acme.example/v1", network: "relay:acme-west" },
          },
          "operator-oauth",
        ),
      ),
    ).toStrictEqual([
      {
        tool: undefined,
        field: "auth.mode",
        message:
          "auth.mode operator-oauth cannot present mutual TLS scheme mtls, because the operator's OAuth token carries no client certificate. Set auth.mode to service.",
      },
    ]);
  });

  it("applies nothing for mode none, or for a server with no auth", () => {
    expect(compile(input({ server: server(definitionServer("openapi")), tools: none, upstream: [] })).auth).toBeNull();
    const local = { ...REMOTE, auth: undefined, source: { type: "local", command: "acme-mcp", machines: ["dev-laptops"] } };
    expect(compile(input({ server: server(local), tools: none, upstream: [] })).auth).toBeNull();
  });

  interface Refusal {
    label: string;
    openapi: boolean;
    scheme: string;
    schemes: Record<string, SecurityScheme>;
    message: string;
  }

  it.each<Refusal>([
    {
      label: "a scheme the OpenAPI document does not declare",
      openapi: true,
      scheme: "acme_key",
      schemes: {},
      message: "auth.scheme acme_key is not a security scheme the OpenAPI document declares.",
    },
    {
      label: "a mutual TLS scheme on the cloud route",
      openapi: true,
      scheme: "mtls",
      schemes: { mtls: { type: "mutual_tls" } },
      message:
        "auth.scheme mtls is mutual TLS, which only a relay that holds the client certificate can present. Environment prod routes over cloud. Set each environment's network to relay:<name>.",
    },
    {
      label: "a scheme that is not built in",
      openapi: false,
      scheme: "digest",
      schemes: {},
      message: "auth.scheme digest is not one of oauth, bearer, basic, header.",
    },
    {
      label: "a header scheme with no header",
      openapi: false,
      scheme: "header",
      schemes: {},
      message: "auth.header is required when scheme is header",
    },
  ])("refuses $label", ({ openapi, scheme, schemes, message }) => {
    // server.toml's checks refuse the last two, so the server is built past them.
    const base = openapi ? server(definitionServer("openapi")) : server();
    const bypassed = { ...base, auth: { mode: "service", scheme, credential: "oxagen:credential/acme" } } as McpServer;
    expect(issues(input({ server: bypassed, tools: none, upstream: [], security_schemes: schemes }))).toStrictEqual([
      { tool: undefined, field: "auth.scheme", message },
    ]);
  });
});

// ── Environments ─────────────────────────────────────────────────────────────

describe("compile resolves each environment", () => {
  const none = tools({});

  it("gives a remote server with no environments one, default, at the source's url", () => {
    expect(compile(input({ tools: none, upstream: [] })).environments).toStrictEqual({
      default: { sandbox: true, network: "cloud", url: "https://mcp.acme.example", credential: "oxagen:credential/acme" },
    });
  });

  it("takes url, network, and credential from each environment, and the rest from the source and auth", () => {
    const compiled = compile(
      input({
        server: server({
          source: { ...REMOTE.source, network: "relay:acme-east" },
          environments: {
            test: { sandbox: true },
            live: { url: "https://live.acme.example", network: "cloud", credential: "oxagen:credential/acme-live" },
          },
        }),
        tools: none,
        upstream: [],
      }),
    );
    expect(compiled.environments).toStrictEqual({
      test: {
        sandbox: true,
        network: "relay:acme-east",
        url: "https://mcp.acme.example",
        credential: "oxagen:credential/acme",
      },
      live: {
        sandbox: false,
        network: "cloud",
        url: "https://live.acme.example",
        credential: "oxagen:credential/acme-live",
      },
    });
  });

  it("runs a local server, or a registry package on machines, on the local gateway", () => {
    const local = { ...REMOTE, auth: undefined, source: { type: "local", command: "acme-mcp" } };
    const onMachines = {
      ...REMOTE,
      auth: undefined,
      source: {
        type: "registry",
        registry: "https://registry.modelcontextprotocol.io",
        server: "io.github.acme/tracker",
        version: "1.0.0",
        machines: ["dev-laptops"],
        registry_type: "npm",
      },
    };
    for (const fields of [local, onMachines]) {
      expect(compile(input({ server: server(fields), tools: none, upstream: [] })).environments).toStrictEqual({
        default: { sandbox: true, network: "local" },
      });
    }
  });

  it("never takes a definition's url for the endpoint", () => {
    // server.toml's checks require each environment's url here, so this one is built past them.
    const base = server(definitionServer("openapi"));
    const bypassed = { ...base, environments: { prod: {} } } as McpServer;
    expect(compile(input({ server: bypassed, tools: none, upstream: [] })).environments).toStrictEqual({
      prod: { sandbox: true, network: "cloud" },
    });
    expect(compile(input({ server: base, tools: none, upstream: [] })).environments).toStrictEqual({
      prod: { sandbox: true, network: "cloud", url: "https://api.acme.example/v1" },
    });
  });

  it("sends no credential for mode none, even one an environment names", () => {
    // server.toml's checks refuse the credential, so the server is built past them.
    const base = server(definitionServer("openapi"));
    const bypassed = {
      ...base,
      environments: { prod: { url: "https://api.acme.example/v1", credential: "oxagen:credential/acme" } },
    } as McpServer;
    expect(compile(input({ server: bypassed, tools: none, upstream: [] })).environments).toStrictEqual({
      prod: { sandbox: true, network: "cloud", url: "https://api.acme.example/v1" },
    });
  });

  it("refuses two environments with no sandbox", () => {
    // server.toml's checks refuse this too, so the server is built past them.
    const bypassed = { ...server(), environments: { test: {}, live: {} } } as McpServer;
    expect(issues(input({ server: bypassed, tools: none, upstream: [] }))).toStrictEqual([
      {
        tool: undefined,
        field: "environments",
        message: "a server with two or more environments marks one sandbox = true",
      },
    ]);
  });
});

// ── Errors ───────────────────────────────────────────────────────────────────

describe("CompileError", () => {
  it("lists every issue in the server, not only the first", () => {
    const bypassed = { ...server(), auth: { mode: "service", scheme: "digest" } } as McpServer;
    let thrown: unknown;
    try {
      compile(input({ server: bypassed, tools: tools({ one: READ, two: READ }), upstream: [] }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CompileError);
    expect((thrown as CompileError).message).toBe(
      [
        "one: the source offers no upstream one.",
        "two: the source offers no upstream two.",
        "auth.scheme digest is not one of oauth, bearer, basic, header.",
      ].join("\n"),
    );
  });
});

// ── Manifest ─────────────────────────────────────────────────────────────────

describe("toManifestServer", () => {
  it("refuses a lock for another server", () => {
    const pinned = stripePin();
    expect(() => toManifestServer(compile(fixtureInput("stripe")), { ...pinned, server: "billing" })).toThrow(
      "The lock is for billing, and the compiled server is stripe.",
    );
  });

  it("refuses a lock with no entry for a compiled tool", () => {
    const pinned = stripePin();
    const { create_refund: _refund, ...rest } = pinned.tools;
    expect(() => toManifestServer(compile(fixtureInput("stripe")), { ...pinned, tools: rest })).toThrow(
      "The lock for stripe has no entry for create_refund. Run lock again.",
    );
  });

  it("refuses a lock whose definition_hash is not the compiled one", () => {
    const pinned = stripePin();
    const stale = { ...pinned.tools.create_refund!, definition_hash: `sha256:${"0".repeat(64)}` };
    const tools = { ...pinned.tools, create_refund: stale };
    expect(() => toManifestServer(compile(fixtureInput("stripe")), { ...pinned, tools })).toThrow(
      "The lock's definition_hash for create_refund is not the compiled one. Run lock again.",
    );
  });

  it("takes a registry remote's url from the lock, unless an environment names one", () => {
    const registry = {
      ...REMOTE,
      name: "github",
      source: {
        type: "registry",
        registry: "https://registry.modelcontextprotocol.io",
        server: "io.github.github/github-mcp-server",
        version: "0.18.0",
      },
      auth: { mode: "operator-oauth", scheme: "oauth", credential: "oxagen:credential/github-app" },
    };
    const entry = registryEntrySchema.parse(json("registry/remote-entry.json"));

    function manifestFor(fields: Record<string, unknown>) {
      const parsed = server({ ...registry, ...fields });
      if (parsed.source.type !== "registry") throw new Error("not a registry source");
      const source = registryLockSource({ source: parsed.source, entry, digest: undefined, server_version: undefined });
      const built = compile(input({ server: parsed, tools: tools({}), upstream: [] }));
      expect(built.environments.default).not.toHaveProperty("url");
      return toManifestServer(built, lock({ compiled: built, source, previous: undefined }));
    }

    const remote = manifestFor({});
    expect(remote.environments.default?.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(remote.pinned).toMatchObject({ url: "https://api.githubcopilot.com/mcp/", transport: "http" });

    const named = manifestFor({
      environments: { default: {}, enterprise: { sandbox: true, url: "https://ghe.acme.example/mcp/" } },
    });
    expect(named.environments.enterprise?.url).toBe("https://ghe.acme.example/mcp/");
    expect(named.environments.default?.url).toBe("https://api.githubcopilot.com/mcp/");
  });
});
