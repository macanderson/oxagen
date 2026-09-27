// Reading a server folder's files: server.toml and tools.toml through S0's
// file rules, the lock in the one form Oxagen writes, the manifest, and the
// two JSON Lines test files.
import { describe, expect, it } from "vitest";
import type { UpstreamTool } from "../model/upstream-tool";
import { documentHash, upstreamHash } from "./hashes";
import { formatJson } from "./json";
import { LOCK_BYTES_MAX, type DefinitionLock, type McpLock } from "./lock";
import type { LockedMcpTool } from "./mcp-tool";
import {
  parseLock,
  parseRecordedCalls,
  parseSelectionTests,
  parseServerToml,
  parseToolManifest,
  parseToolsToml,
} from "./parse";

const SERVER_DIRECTIVE = "#:schema https://oxagen.sh/schemas/mcp-server/v1.json";
const TOOLS_DIRECTIVE = "#:schema https://oxagen.sh/schemas/mcp-tools/v1.json";
const SERVER_NAME_MESSAGE =
  "a server name starts with a letter and has at most 24 lowercase letters, digits, and underscores";
const HAND_EDIT_MESSAGE =
  "tools.lock.json is not in the form Oxagen writes, so it was edited by hand. Change tools.toml instead, and let Oxagen write the lock.";

/** Lines joined with LF and ending in a newline, as every steering repo file is. */
function file(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

/** The 1-based number of the first line that reads `line`. */
function lineOf(lines: readonly string[], line: string): number {
  const index = lines.indexOf(line);
  if (index < 0) throw new Error(`no line reads ${line}`);
  return index + 1;
}

/** The lines with `line` added after the first line that reads `after`. */
function withLine(lines: readonly string[], after: string, line: string): string[] {
  const at = lineOf(lines, after);
  return [...lines.slice(0, at), line, ...lines.slice(at)];
}

/** The lines with the one that reads `from` changed to `to`. */
function replaced(lines: readonly string[], from: string, to: string): string[] {
  lineOf(lines, from);
  return lines.map((line) => (line === from ? to : line));
}

// The spec's stripe server.toml.
const stripeLines = [
  SERVER_DIRECTIVE,
  'schema = "mcp-server/v1"',
  'name = "stripe"',
  'label = "Stripe"',
  'description = "Payments, refunds, and customers in Stripe."',
  "",
  "[source]",
  'type = "remote"',
  'url = "https://mcp.stripe.com"',
  'transport = "http"',
  "",
  "[auth]",
  'mode = "service"',
  'scheme = "oauth"',
  "",
  "[environments.test]",
  "sandbox = true",
  'credential = "oxagen:credential/stripe-test"',
  "",
  "[environments.live]",
  'credential = "oxagen:credential/stripe-live"',
  "",
  "[exposure]",
  'mode = "direct"',
  "definition_budget = 8000",
  "",
  "[sync]",
  'schedule = "daily"',
];

describe("parseServerToml", () => {
  it("reads the spec's stripe server", () => {
    expect(parseServerToml(file(stripeLines))).toMatchObject({
      ok: true,
      value: {
        schema: "mcp-server/v1",
        name: "stripe",
        source: { type: "remote", url: "https://mcp.stripe.com", transport: "http" },
        auth: { mode: "service", scheme: "oauth" },
        environments: {
          test: { sandbox: true, credential: "oxagen:credential/stripe-test" },
          live: { credential: "oxagen:credential/stripe-live" },
        },
        exposure: { mode: "direct", definition_budget: 8000 },
        sync: { schedule: "daily" },
      },
    });
  });

  it("asks for the schema directive on the first line", () => {
    const missing = parseServerToml(file(stripeLines.slice(1)));
    const directive = { line: 1, field: null, message: `the first line must be ${SERVER_DIRECTIVE}` };
    expect(missing).toStrictEqual({ ok: false, issues: [directive] });
    const wrong = parseServerToml(file([TOOLS_DIRECTIVE, ...stripeLines.slice(1)]));
    expect(wrong).toStrictEqual({ ok: false, issues: [directive] });
  });

  it("refuses an empty file", () => {
    expect(parseServerToml("")).toStrictEqual({
      ok: false,
      issues: [{ line: null, field: null, message: "the file is empty" }],
    });
  });

  it("refuses a byte-order mark", () => {
    expect(parseServerToml(`﻿${file(stripeLines)}`)).toStrictEqual({
      ok: false,
      issues: [
        { line: 1, field: null, message: "the file starts with a byte-order mark. Save it as UTF-8 without one." },
      ],
    });
  });

  it("refuses CRLF line endings", () => {
    expect(parseServerToml(file(stripeLines).split("\n").join("\r\n"))).toStrictEqual({
      ok: false,
      issues: [{ line: 1, field: null, message: "the file has CRLF line endings. Use LF." }],
    });
  });

  it("refuses a file with no final newline", () => {
    expect(parseServerToml(stripeLines.join("\n"))).toStrictEqual({
      ok: false,
      issues: [{ line: stripeLines.length, field: null, message: "the file does not end with a newline" }],
    });
  });

  it("names the line TOML stopped on", () => {
    const lines = [SERVER_DIRECTIVE, 'schema = "mcp-server/v1"', 'name = "stripe"', 'name = "billing"'];
    expect(parseServerToml(file(lines))).toStrictEqual({
      ok: false,
      issues: [
        {
          line: 4,
          field: null,
          message: "the file is not TOML: Invalid TOML document: trying to redefine an already defined table or value",
        },
      ],
    });
  });

  it("names the line and field of a value the schema refuses", () => {
    const lines = replaced(stripeLines, 'name = "stripe"', 'name = "Stripe"');
    expect(parseServerToml(file(lines))).toStrictEqual({
      ok: false,
      issues: [{ line: lineOf(lines, 'name = "Stripe"'), field: "name", message: SERVER_NAME_MESSAGE }],
    });
  });

  it("points a nested field at the table that holds it", () => {
    const lines = replaced(stripeLines, "definition_budget = 8000", "definition_budget = 0");
    const result = parseServerToml(file(lines));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ line: lineOf(lines, "[exposure]"), field: "exposure.definition_budget" }),
    );
  });

  it("names an unknown top-level key on its own line", () => {
    const lines = withLine(stripeLines, 'label = "Stripe"', 'owner = "payments"');
    expect(parseServerToml(file(lines))).toStrictEqual({
      ok: false,
      issues: [
        {
          line: lineOf(lines, 'owner = "payments"'),
          field: "owner",
          message: "owner is not a known field. Remove it or check its spelling.",
        },
      ],
    });
  });

  it("names an unknown nested key on its table's line", () => {
    const lines = withLine(stripeLines, 'schedule = "daily"', 'timezone = "UTC"');
    expect(parseServerToml(file(lines))).toStrictEqual({
      ok: false,
      issues: [
        {
          line: lineOf(lines, "[sync]"),
          field: "sync.timezone",
          message: "timezone is not a known field. Remove it or check its spelling.",
        },
      ],
    });
  });
});

const toolsLines = [
  TOOLS_DIRECTIVE,
  'schema = "mcp-tools/v1"',
  "",
  "[defaults]",
  "max_result_bytes = 65536",
  "",
  "[tools.create_refund]",
  'risk = "high"',
  'side_effect = "irreversible"',
  'egress = "third_party"',
  'impacts = ["moves_money"]',
  "",
  "[tools.create_refund.measures.amount]",
  'path = "$.amount"',
  'type = "money"',
  'currency_path = "$.currency"',
  "",
  "[tools.list_charges]",
  'risk = "low"',
  'side_effect = "read"',
  'egress = "third_party"',
  'select = ["data[].id", "data[].amount", "has_more"]',
];

describe("parseToolsToml", () => {
  it("reads every tool with its classification and shaping", () => {
    expect(parseToolsToml(file(toolsLines))).toMatchObject({
      ok: true,
      value: {
        schema: "mcp-tools/v1",
        defaults: { max_result_bytes: 65_536 },
        tools: {
          create_refund: {
            risk: "high",
            impacts: ["moves_money"],
            measures: { amount: { path: "$.amount", type: "money", currency_path: "$.currency" } },
          },
          list_charges: { risk: "low", select: ["data[].id", "data[].amount", "has_more"] },
        },
      },
    });
  });

  it("asks for the tools directive, not the server one", () => {
    expect(parseToolsToml(file([SERVER_DIRECTIVE, ...toolsLines.slice(1)]))).toStrictEqual({
      ok: false,
      issues: [{ line: 1, field: null, message: `the first line must be ${TOOLS_DIRECTIVE}` }],
    });
  });

  it("reports a cross-field check on the tool's field, at the first tools table", () => {
    const lines = withLine(toolsLines, 'select = ["data[].id", "data[].amount", "has_more"]', "max_items = 50");
    expect(parseToolsToml(file(lines))).toStrictEqual({
      ok: false,
      issues: [
        {
          line: lineOf(lines, "[tools.create_refund]"),
          field: "tools.list_charges.max_items",
          message: "max_items needs paginate, or method for a gRPC server stream",
        },
      ],
    });
  });
});

const refund: LockedMcpTool = {
  name: "create_refund",
  description: "Refund a charge.",
  inputSchema: { type: "object", properties: { charge: { type: "string" } }, required: ["charge"] },
  annotations: { destructiveHint: true, openWorldHint: true },
};

const mcpLock: McpLock = {
  schema: "mcp-tools-lock/v1",
  server: "stripe",
  source: { type: "remote", url: "https://mcp.stripe.com", server_version: "2025.9.1" },
  tools: {
    create_refund: {
      definition_hash: documentHash("stripe__create_refund"),
      upstream: refund,
      upstream_hash: upstreamHash(refund),
      version: 1,
    },
  },
};

const getInvoice: UpstreamTool = {
  name: "get_invoice",
  description: "Read one invoice.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  request: {
    kind: "http",
    operation: "getInvoice",
    method: "GET",
    path: "/invoices/{id}",
    parameters: [{ name: "id", in: "path", property: "id", required: true }],
  },
};

const definitionLock: DefinitionLock = {
  schema: "mcp-tools-lock/v1",
  server: "billing",
  source: {
    type: "openapi",
    from: "repository",
    document_hash: documentHash("openapi: 3.1.0\n"),
    repo: "github.com/a-intel/billing-service",
    path: "openapi/billing.yaml",
    ref: "main",
    commit: "0123456789abcdef0123456789abcdef01234567",
    security_schemes: {
      oauth: { type: "oauth2", token_url: "https://billing.a-intel.com/oauth/token", scopes: ["invoices:read"] },
    },
  },
  tools: {
    get_invoice: {
      definition_hash: documentHash("billing__get_invoice"),
      upstream: getInvoice,
      upstream_hash: upstreamHash(getInvoice),
      version: 1,
    },
  },
};

describe("parseLock", () => {
  it("reads an MCP lock and a definition lock in the form Oxagen writes", () => {
    expect(parseLock(formatJson(mcpLock))).toEqual({ ok: true, value: mcpLock });
    expect(parseLock(formatJson(definitionLock))).toEqual({ ok: true, value: definitionLock });
  });

  it("refuses a lock in any other form as edited by hand", () => {
    const indented = `${JSON.stringify(mcpLock, null, 4)}\n`;
    expect(parseLock(indented)).toStrictEqual({
      ok: false,
      issues: [{ line: null, field: null, message: HAND_EDIT_MESSAGE }],
    });
  });

  it("refuses a lock over 5 MB, counted in bytes", () => {
    const text = "é".repeat(LOCK_BYTES_MAX / 2 + 1);
    expect(parseLock(text)).toStrictEqual({
      ok: false,
      issues: [
        {
          line: null,
          field: null,
          message: `tools.lock.json is ${LOCK_BYTES_MAX + 2} bytes, over the limit of ${LOCK_BYTES_MAX}`,
        },
      ],
    });
  });

  it("reads a lock of exactly 5 MB past the size check", () => {
    const result = parseLock(`${"x".repeat(LOCK_BYTES_MAX - 1)}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/^tools\.lock\.json is not JSON: /);
  });

  it("applies the encoding rules before reading JSON", () => {
    expect(parseLock("")).toStrictEqual({
      ok: false,
      issues: [{ line: null, field: null, message: "the file is empty" }],
    });
    expect(parseLock(formatJson(mcpLock).split("\n").join("\r\n"))).toStrictEqual({
      ok: false,
      issues: [{ line: 1, field: null, message: "the file has CRLF line endings. Use LF." }],
    });
  });

  it("refuses text that is not JSON", () => {
    const result = parseLock("{\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: null, field: null });
    expect(result.issues[0]?.message).toMatch(/^tools\.lock\.json is not JSON: /);
  });

  it("names the field the schema refuses", () => {
    const result = parseLock(formatJson({ ...mcpLock, server: "Stripe" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ line: null, field: "server", message: SERVER_NAME_MESSAGE });
  });

  it("asks a repository source for the commit it resolved", () => {
    const { commit: _commit, ...source } = definitionLock.source;
    const result = parseLock(formatJson({ ...definitionLock, source }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      line: null,
      field: "source.commit",
      message: "commit is required when from is repository",
    });
  });
});

describe("parseToolManifest", () => {
  it("reads a manifest in any key order", () => {
    const value = { schema: "tool-manifest/v1", servers: [] };
    expect(parseToolManifest('{"schema":"tool-manifest/v1","servers":[]}\n')).toStrictEqual({ ok: true, value });
    expect(parseToolManifest('{"servers":[],"schema":"tool-manifest/v1"}\n')).toStrictEqual({ ok: true, value });
  });

  it("refuses another schema id", () => {
    const result = parseToolManifest('{"schema":"tool-manifest/v2","servers":[]}\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ line: null, field: "schema" }));
  });

  it("refuses text that is not JSON, and text with no final newline", () => {
    const notJson = parseToolManifest("servers\n");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.issues[0]?.message).toMatch(/^the tool manifest is not JSON: /);
    expect(parseToolManifest('{"schema":"tool-manifest/v1","servers":[]}')).toStrictEqual({
      ok: false,
      issues: [{ line: 1, field: null, message: "the file does not end with a newline" }],
    });
  });
});

// One saved call for each kind of source.
const refundExchange = {
  request: {
    method: "POST",
    path: "/refunds",
    headers: { "idempotency-key": "k1" },
    body: { charge: "ch_1" },
  },
  response: { status: 200, body: { id: "re_1", status: "succeeded" } },
};
const httpCall = {
  tool: "create_refund",
  arguments: { charge: "ch_1" },
  exchanges: [refundExchange],
  result: { id: "re_1", status: "succeeded" },
  recorded_at: "2026-09-26T12:00:00Z",
};
const graphqlCall = {
  tool: "list_issues",
  arguments: { first: 2 },
  exchanges: [
    {
      request: { query: "query ($first: Int) { issues(first: $first) { nodes { id } } }", variables: { first: 2 } },
      response: { status: 200, body: { data: { issues: { nodes: [] } } } },
    },
  ],
  result: { nodes: [] },
};
const grpcCall = {
  tool: "list_entries",
  arguments: { account: "a1" },
  exchanges: [
    {
      request: { method: "a_intel.ledger.v1.Ledger/ListEntries", message: { account: "a1" } },
      response: { code: "OK", messages: [{ id: "e1" }, { id: "e2" }] },
    },
  ],
  result: { items: [{ id: "e1" }, { id: "e2" }] },
};
const mcpCall = {
  tool: "get_issue",
  arguments: { number: 1 },
  exchanges: [
    {
      request: { name: "get-issue", arguments: { number: 1 } },
      response: { content: [{ type: "text", text: "Issue 1" }], isError: false },
    },
  ],
  result: "Issue 1",
};

/** JSON Lines: one object per line, and a final newline. */
function jsonLines(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

describe("parseRecordedCalls", () => {
  it("reads an HTTP, a GraphQL, a gRPC, and an MCP call", () => {
    const calls = [httpCall, graphqlCall, grpcCall, mcpCall];
    expect(parseRecordedCalls(jsonLines(calls))).toStrictEqual({ ok: true, value: calls });
  });

  it("names the line that is not JSON", () => {
    const text = `${JSON.stringify(httpCall)}\n{not json\n`;
    expect(parseRecordedCalls(text)).toStrictEqual({
      ok: false,
      issues: [{ line: 2, field: null, message: "the line is not one JSON object" }],
    });
  });

  it("asks for the result, even when the other fields are there", () => {
    const { result: _result, ...noResult } = mcpCall;
    expect(parseRecordedCalls(jsonLines([httpCall, noResult]))).toStrictEqual({
      ok: false,
      issues: [{ line: 2, field: "result", message: "Required" }],
    });
  });

  it("reads a paged call with one exchange per page, in the order they were sent", () => {
    const pagedCall = {
      tool: "list_charges",
      arguments: { customer_id: "cus_81" },
      exchanges: [
        {
          request: { method: "GET", path: "/customers/cus_81/charges" },
          response: { status: 200, body: { data: [{ id: "ch_2" }], next_cursor: "c2" } },
        },
        {
          request: { method: "GET", path: "/customers/cus_81/charges", query: { cursor: "c2" } },
          response: { status: 200, body: { data: [{ id: "ch_1" }] } },
        },
      ],
      result: { data: [{ id: "ch_2" }, { id: "ch_1" }] },
    };
    expect(parseRecordedCalls(jsonLines([pagedCall]))).toStrictEqual({ ok: true, value: [pagedCall] });
  });

  it("refuses a call with no exchanges", () => {
    expect(parseRecordedCalls(jsonLines([{ ...mcpCall, exchanges: [] }]))).toStrictEqual({
      ok: false,
      issues: [{ line: 1, field: "exchanges", message: "a recorded call has at least one exchange" }],
    });
  });

  it("refuses a request path that does not start with /", () => {
    const exchange = { ...refundExchange, request: { ...refundExchange.request, path: "refunds" } };
    const call = { ...httpCall, exchanges: [exchange] };
    expect(parseRecordedCalls(jsonLines([call]))).toStrictEqual({
      ok: false,
      issues: [{ line: 1, field: "exchanges.0.request.path", message: "a path starts with / and has no fragment" }],
    });
  });

  it("refuses a call that recorded a credential, on the header that holds it", () => {
    const headers = { ...refundExchange.request.headers, Authorization: "Bearer sk_live_1" };
    const exchange = { ...refundExchange, request: { ...refundExchange.request, headers } };
    const call = { ...httpCall, exchanges: [exchange] };
    expect(parseRecordedCalls(jsonLines([call]))).toStrictEqual({
      ok: false,
      issues: [
        {
          line: 1,
          field: "exchanges.0.request.headers.Authorization",
          message: "the Authorization header is not allowed: a recorded call holds no credential",
        },
      ],
    });
  });
});

describe("parseSelectionTests", () => {
  it("reads each task and the tool it expects", () => {
    const tests = [
      { task: "Refund the last charge for Acme.", expect: "stripe__create_refund" },
      { task: "List the open invoices.", expect: "billing__list_invoices" },
    ];
    expect(parseSelectionTests(jsonLines(tests))).toStrictEqual({ ok: true, value: tests });
  });

  it("refuses a tool named without its server", () => {
    const result = parseSelectionTests(jsonLines([{ task: "Refund a charge.", expect: "create_refund" }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ line: 1, field: "expect" }));
  });

  it("refuses an empty task", () => {
    const result = parseSelectionTests(jsonLines([{ task: "", expect: "stripe__create_refund" }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ line: 1, field: "task" }));
  });
});
