// catalog.test.ts: the rows of list_studio_tools (lane M10, #4682). Each case
// builds a server folder the way the production branch holds it, from
// server.toml, tools.toml, and a lock that compile() and lock() wrote, then
// checks one part of the answer: the order of the two groups, an imported
// tool's confirmed classification, an available tool's suggestion, or the
// token totals.
import { describe, expect, it } from "vitest";
import {
  compile,
  definitionTokens,
  effectiveAnnotations,
  lock,
  mcpToolSchema,
  parseServerToml,
  parseToolsToml,
  upstreamFromMcpTool,
  type DefinitionLockSource,
  type McpLockSource,
  type ReadResult,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import { TOOL_SEPARATOR } from "@oxagen/oxagen/steering-repo/names";
import { DEFAULT_SERVER_DEFINITION_BUDGET } from "@oxagen/oxagen/steering-repo/tokens";
import { toolCatalog, type ToolCatalogInput } from "./catalog";
import type { StoredTool } from "./store";
import type { ServerFiles } from "./sync";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AT = new Date("2026-09-28T15:00:12Z");
const LATER = new Date("2026-09-28T16:30:00Z");

/** A tool as an MCP server lists it in tools/list. */
interface RawTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const CREATE_REFUND: RawTool = {
  name: "create_refund",
  description: "Create a refund for a charge.",
  inputSchema: {
    type: "object",
    properties: { amount: { type: "integer" }, charge: { type: "string" } },
    required: ["charge"],
  },
  annotations: { destructiveHint: true },
};

const LIST_CHARGES: RawTool = {
  name: "list_charges",
  description: "List charges, newest first.",
  inputSchema: {
    type: "object",
    properties: { customer: { type: "string" }, limit: { type: "integer" } },
  },
  annotations: { readOnlyHint: true },
};

const CREATE_CUSTOMER: RawTool = {
  name: "create_customer",
  description: "Create a customer.",
  inputSchema: { type: "object", properties: { email: { type: "string" } } },
};

const STRIPE_UPSTREAM: readonly RawTool[] = [CREATE_REFUND, LIST_CHARGES, CREATE_CUSTOMER];

const STRIPE_SERVER = [
  "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
  'schema = "mcp-server/v1"',
  'name = "stripe"',
  'label = "Stripe"',
  'description = "Payments and refunds in the a-intel Stripe account."',
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
  "",
].join("\n");

const STRIPE_TOOLS = [
  "#:schema https://oxagen.sh/schemas/mcp-tools/v1.json",
  'schema = "mcp-tools/v1"',
  "",
  "[defaults]",
  "max_result_bytes = 16384",
  "",
  "[tools.list_charges]",
  'risk = "low"',
  'side_effect = "read"',
  'egress = "third_party"',
  "",
  "[tools.create_refund]",
  'description = "Refund part or all of a captured charge. In cents."',
  'risk = "high"',
  'side_effect = "irreversible"',
  'egress = "third_party"',
  'impacts = ["moves_money"]',
  "",
].join("\n");

const STRIPE_SOURCE: McpLockSource = {
  type: "remote",
  url: "https://mcp.stripe.com",
  server_version: "2026.09.1",
};

/** A tools.toml with no keys, for a server nothing is imported from yet. */
const NO_TOOLS = ['schema = "mcp-tools/v1"', ""].join("\n");

/** A server built from a definition Oxagen fetches from a url. */
function definitionServer(type: "openapi" | "grpc"): string {
  return [
    'schema = "mcp-server/v1"',
    'name = "ledger"',
    'label = "Ledger"',
    'description = "Accounts and entries in the a-intel ledger."',
    "",
    "[source]",
    `type = "${type}"`,
    'from = "url"',
    `url = "https://ledger.a-intel.com/${type === "grpc" ? "ledger.binpb" : "openapi.json"}"`,
    "",
    "[auth]",
    'mode = "none"',
    "",
    "[environments.production]",
    'url = "https://ledger.a-intel.com/v1"',
    "",
    "[exposure]",
    'mode = "direct"',
    "",
    "[sync]",
    'schedule = "manual"',
    "",
  ].join("\n");
}

function definitionSource(type: "openapi" | "grpc"): DefinitionLockSource {
  return {
    type,
    from: "url",
    url: `https://ledger.a-intel.com/${type === "grpc" ? "ledger.binpb" : "openapi.json"}`,
    document_hash: `sha256:${"0".repeat(64)}`,
  };
}

function must<T>(result: ReadResult<T>): T {
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.value;
}

function upstreamOf(tools: readonly RawTool[]): UpstreamTool[] {
  return tools.map((tool) => upstreamFromMcpTool(mcpToolSchema.parse(tool)));
}

/**
 * The folder's three files. The lock is compiled from lockToolsText when set,
 * so a case can hand the catalog a tools.toml the lock does not pin.
 */
function folder(options: {
  serverText: string;
  toolsText: string;
  upstream: readonly UpstreamTool[];
  source: McpLockSource | DefinitionLockSource;
  lockToolsText?: string;
}): ServerFiles {
  const parsed = must(parseServerToml(options.serverText));
  const compiled = compile({
    server: parsed,
    tools: must(parseToolsToml(options.lockToolsText ?? options.toolsText)),
    upstream: options.upstream,
    security_schemes: {},
    descriptor_set: parsed.source.type === "grpc" ? new Uint8Array() : undefined,
  });
  return {
    parsed,
    serverText: options.serverText,
    tools: must(parseToolsToml(options.toolsText)),
    lock: lock({ compiled, source: options.source, previous: undefined }),
  };
}

function stripeFolder(
  options: { serverText?: string; toolsText?: string; lockToolsText?: string } = {},
): ServerFiles {
  return folder({
    serverText: options.serverText ?? STRIPE_SERVER,
    toolsText: options.toolsText ?? STRIPE_TOOLS,
    upstream: upstreamOf(STRIPE_UPSTREAM),
    source: STRIPE_SOURCE,
    ...(options.lockToolsText === undefined ? {} : { lockToolsText: options.lockToolsText }),
  });
}

/** A tool as mcp.tool_snapshots keeps it. */
function stored(tool: RawTool, snapshotId: string, capturedAt: Date = AT): StoredTool {
  return {
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null,
    snapshotId,
    capturedAt,
  };
}

const OFFERED: readonly StoredTool[] = [
  stored(CREATE_REFUND, "snap_refund"),
  stored(LIST_CHARGES, "snap_charges"),
  stored(CREATE_CUSTOMER, "snap_customer"),
];

function catalog(overrides: Partial<ToolCatalogInput> = {}) {
  return toolCatalog({
    server: "stripe",
    mcpServerId: "mcs_1",
    files: stripeFolder(),
    offered: OFFERED,
    withheldUpstream: [],
    ...overrides,
  });
}

function rowOf(out: ReturnType<typeof catalog>, name: string) {
  const row = out.tools.find((tool) => tool.name === name);
  if (row === undefined) throw new Error(`The catalog has no row for ${name}.`);
  return row;
}

/** stripe compiled straight from tools/list, without the lock's round trip. */
function stripeCompiled() {
  return compile({
    server: must(parseServerToml(STRIPE_SERVER)),
    tools: must(parseToolsToml(STRIPE_TOOLS)),
    upstream: upstreamOf(STRIPE_UPSTREAM),
    security_schemes: {},
    descriptor_set: undefined,
  });
}

// ── Cases ────────────────────────────────────────────────────────────────────

describe("toolCatalog", () => {
  it("lists each tools.toml key by key, then each offered tool no key imports", () => {
    const out = catalog();
    expect(out.tools.map((tool) => [tool.state, tool.key, tool.name])).toEqual([
      ["imported", "create_refund", "create_refund"],
      ["imported", "list_charges", "list_charges"],
      ["available", null, "create_customer"],
    ]);
    expect(out).toMatchObject({
      server: "stripe",
      mcpServerId: "mcs_1",
      imported: 2,
      offered: 3,
      compileError: null,
    });
  });

  it("gives an imported tool the classification tools.toml confirms and its compiled tokens", () => {
    const out = catalog();
    const expected = stripeCompiled();
    expect(rowOf(out, "create_refund")).toEqual({
      name: "create_refund",
      key: "create_refund",
      state: "imported",
      description: "Create a refund for a charge.",
      importedDescription: "Refund part or all of a captured charge. In cents.",
      inputSchema: CREATE_REFUND.inputSchema,
      annotations: { destructiveHint: true },
      tokens: expected.tools.create_refund?.tokens,
      classification: {
        risk: "high",
        sideEffect: "irreversible",
        egress: "third_party",
        impacts: ["moves_money"],
        confirmed: true,
        basis: null,
      },
      snapshotId: "snap_refund",
      capturedAt: AT.toISOString(),
      withheld: false,
    });
    expect(rowOf(out, "list_charges")).toMatchObject({
      importedDescription: null,
      tokens: expected.tools.list_charges?.tokens,
      classification: {
        risk: "low",
        sideEffect: "read",
        egress: "third_party",
        impacts: [],
        confirmed: true,
        basis: null,
      },
    });
    expect(out.tokens.definitions).toBe(expected.tokens.definitions);
  });

  it("suggests a classification for an available tool and leaves it unconfirmed", () => {
    const row = rowOf(catalog(), "create_customer");
    const tokens = definitionTokens({
      name: `stripe${TOOL_SEPARATOR}create_customer`,
      description: "Create a customer.",
      inputSchema: { type: "object", properties: { email: { type: "string" } } },
      annotations: effectiveAnnotations({ side_effect: "write", egress: "third_party" }),
    });
    expect(tokens).toBeGreaterThan(0);
    expect(row).toEqual({
      name: "create_customer",
      key: null,
      state: "available",
      description: "Create a customer.",
      importedDescription: null,
      inputSchema: CREATE_CUSTOMER.inputSchema,
      annotations: null,
      tokens,
      classification: {
        risk: "high",
        sideEffect: "write",
        egress: "third_party",
        impacts: [],
        confirmed: false,
        basis: "fail_safe",
      },
      snapshotId: "snap_customer",
      capturedAt: AT.toISOString(),
      withheld: false,
    });
  });

  it.each([
    {
      hints: { destructiveHint: true },
      classification: {
        risk: "high",
        sideEffect: "irreversible",
        egress: "third_party",
        impacts: ["destroys_data"],
        basis: "annotations",
      },
    },
    {
      hints: { readOnlyHint: true, openWorldHint: false },
      classification: {
        risk: "low",
        sideEffect: "read",
        egress: "org_tenant",
        impacts: [],
        basis: "annotations",
      },
    },
    {
      hints: { destructiveHint: false },
      classification: {
        risk: "medium",
        sideEffect: "write",
        egress: "third_party",
        impacts: [],
        basis: "annotations",
      },
    },
    {
      // A hint the lock's schema does not know drops every hint.
      hints: { readOnlyHint: true, vendorHint: 1 },
      classification: {
        risk: "high",
        sideEffect: "write",
        egress: "third_party",
        impacts: [],
        basis: "fail_safe",
      },
    },
  ])("reads an available tool's hints $hints", ({ hints, classification }) => {
    const tool: RawTool = {
      name: "void_charge",
      description: "Void a charge.",
      inputSchema: { type: "object", properties: { charge: { type: "string" } } },
      annotations: hints,
    };
    const row = rowOf(catalog({ offered: [stored(tool, "snap_void")] }), "void_charge");
    expect(row.state).toBe("available");
    expect(row.annotations).toEqual(hints);
    expect(row.classification).toEqual({ ...classification, confirmed: false });
  });

  it("shows an imported tool as the newest snapshot has it", () => {
    const reworded: RawTool = {
      ...LIST_CHARGES,
      description: "List charges, newest first. A page holds at most 100.",
    };
    const out = catalog({ offered: [stored(reworded, "snap_reworded", LATER)] });
    expect(rowOf(out, "list_charges")).toMatchObject({
      description: "List charges, newest first. A page holds at most 100.",
      tokens: stripeCompiled().tools.list_charges?.tokens,
      snapshotId: "snap_reworded",
      capturedAt: LATER.toISOString(),
    });
  });

  it("shows an imported tool as the lock pins it before the first discovery", () => {
    const out = catalog({ offered: [] });
    expect(out.tools.map((tool) => tool.name)).toEqual(["create_refund", "list_charges"]);
    expect(rowOf(out, "create_refund")).toMatchObject({
      description: "Create a refund for a charge.",
      inputSchema: CREATE_REFUND.inputSchema,
      annotations: { destructiveHint: true },
      snapshotId: null,
      capturedAt: null,
    });
    expect(out).toMatchObject({ offered: 0, snapshotId: null, capturedAt: null });
  });

  it("keeps a renamed key's upstream tool out of the available tools", () => {
    const renamed = STRIPE_TOOLS.replace(
      "[tools.create_refund]",
      '[tools.refund]\nupstream = "create_refund"',
    );
    const out = catalog({ files: stripeFolder({ toolsText: renamed }) });
    expect(out.tools.map((tool) => [tool.state, tool.key, tool.name])).toEqual([
      ["imported", "list_charges", "list_charges"],
      ["imported", "refund", "create_refund"],
      ["available", null, "create_customer"],
    ]);
    expect(rowOf(out, "create_refund").snapshotId).toBe("snap_refund");
  });

  describe("the budget", () => {
    it("reads server.toml's definition budget", () => {
      const out = catalog();
      expect(out.exposure).toEqual({ mode: "direct", budget: 8000 });
      expect(out.tokens.budget).toBe(8000);
      expect(out.searchRecommended).toBe(false);
    });

    it("recommends search when a direct server's definitions exceed the budget", () => {
      const serverText = STRIPE_SERVER.replace("definition_budget = 8000", "definition_budget = 1");
      const out = catalog({ files: stripeFolder({ serverText }) });
      expect(out.tokens).toEqual({ definitions: stripeCompiled().tokens.definitions, budget: 1 });
      expect(out.searchRecommended).toBe(true);
    });

    it("never recommends search to a server that already uses it", () => {
      const serverText = STRIPE_SERVER.replace("definition_budget = 8000", "definition_budget = 1").replace(
        'mode = "direct"',
        'mode = "search"',
      );
      const out = catalog({ files: stripeFolder({ serverText }) });
      expect(out.exposure).toEqual({ mode: "search", budget: 1 });
      expect(out.searchRecommended).toBe(false);
    });

    it("takes the default budget when server.toml names none", () => {
      const serverText = STRIPE_SERVER.replace("definition_budget = 8000\n", "");
      const out = catalog({ files: stripeFolder({ serverText }) });
      expect(out.exposure.budget).toBe(DEFAULT_SERVER_DEFINITION_BUDGET);
      expect(out.tokens.budget).toBe(DEFAULT_SERVER_DEFINITION_BUDGET);
    });
  });

  it("lists a folder that does not compile, with the compiler's message and no token counts", () => {
    const toolsText = [
      STRIPE_TOOLS,
      "[tools.void_charge]",
      'risk = "high"',
      'side_effect = "write"',
      'egress = "third_party"',
      "",
    ].join("\n");
    const out = catalog({ files: stripeFolder({ toolsText, lockToolsText: STRIPE_TOOLS }) });
    expect(out.compileError).toContain("void_charge");
    expect(out.tokens.definitions).toBeNull();
    expect(out.searchRecommended).toBe(false);
    expect(out.tools.map((tool) => [tool.state, tool.name])).toEqual([
      ["imported", "create_refund"],
      ["imported", "list_charges"],
      ["imported", "void_charge"],
      ["available", "create_customer"],
    ]);
    for (const row of out.tools.filter((tool) => tool.state === "imported")) {
      expect(row.tokens).toBeNull();
    }
    expect(rowOf(out, "create_refund").description).toBe("Create a refund for a charge.");
    expect(rowOf(out, "void_charge")).toEqual({
      name: "void_charge",
      key: "void_charge",
      state: "imported",
      description: null,
      importedDescription: null,
      inputSchema: {},
      annotations: null,
      tokens: null,
      classification: {
        risk: "high",
        sideEffect: "write",
        egress: "third_party",
        impacts: [],
        confirmed: true,
        basis: null,
      },
      snapshotId: null,
      capturedAt: null,
      withheld: false,
    });
    expect(rowOf(out, "create_customer").tokens).toBeGreaterThan(0);
  });

  it("marks each tool the gateway withholds", () => {
    const out = catalog({ withheldUpstream: ["create_customer", "create_refund"] });
    expect(out.tools.map((tool) => [tool.name, tool.withheld])).toEqual([
      ["create_refund", true],
      ["list_charges", false],
      ["create_customer", true],
    ]);
  });

  it("dates the answer by the newest snapshot among the offered tools", () => {
    const out = catalog({
      offered: [
        stored(CREATE_REFUND, "snap_refund", AT),
        stored(CREATE_CUSTOMER, "snap_new", LATER),
        stored(LIST_CHARGES, "snap_charges", AT),
      ],
    });
    expect(out.snapshotId).toBe("snap_new");
    expect(out.capturedAt).toBe(LATER.toISOString());
  });

  it("suggests fail_safe for an OpenAPI tool, whose snapshot keeps at most idempotentHint", () => {
    const files = folder({
      serverText: definitionServer("openapi"),
      toolsText: NO_TOOLS,
      upstream: [],
      source: definitionSource("openapi"),
    });
    const put: RawTool = {
      name: "put_account",
      description: "Replace an account.",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      annotations: { idempotentHint: true },
    };
    const out = catalog({ server: "ledger", files, offered: [stored(put, "snap_put")] });
    expect(out).toMatchObject({ imported: 0, compileError: null, tokens: { definitions: 0 } });
    expect(rowOf(out, "put_account").classification).toEqual({
      risk: "high",
      sideEffect: "write",
      egress: "third_party",
      impacts: [],
      confirmed: false,
      basis: "fail_safe",
    });
  });

  it("compiles a gRPC folder without the descriptor set the served manifest needs", () => {
    const files = folder({
      serverText: definitionServer("grpc"),
      toolsText: NO_TOOLS,
      upstream: [],
      source: definitionSource("grpc"),
    });
    const method: RawTool = {
      name: "GetAccount",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    };
    const out = catalog({ server: "ledger", files, offered: [stored(method, "snap_get")] });
    expect(out.compileError).toBeNull();
    expect(out.tokens.definitions).toBe(0);
    expect(rowOf(out, "GetAccount")).toMatchObject({
      state: "available",
      description: null,
      classification: { basis: "fail_safe", confirmed: false },
    });
  });
});
