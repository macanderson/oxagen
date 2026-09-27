// An MCP tools/list entry as an UpstreamTool, and the part of it a lock pins.
import { describe, expect, it } from "vitest";
import { lockedMcpTool, lockedMcpToolSchema, mcpToolSchema, mcpToolsListResultSchema } from "../contract/mcp-tool";
import { lockedUpstream, upstreamFromMcpTool } from "./from-mcp";
import { upstreamToolSchema, type UpstreamTool } from "./upstream-tool";

const annotated = mcpToolSchema.parse({
  name: "create_refund",
  title: "Create a refund",
  description: "Refund a charge, in full or in part.",
  inputSchema: { type: "object", properties: { charge: { type: "string" } }, required: ["charge"] },
  outputSchema: { type: "object", properties: { id: { type: "string" } } },
  annotations: { destructiveHint: true, openWorldHint: true, vendorHint: "refunds" },
  _meta: { "io.example/trace": true },
  icons: [{ src: "https://example.com/refund.png" }],
});

const bare = mcpToolSchema.parse({ name: "list_charges", inputSchema: { type: "object" } });

const hyphenated = mcpToolSchema.parse({
  name: "get-issue",
  description: "Read one issue.",
  inputSchema: { type: "object", properties: { number: { type: "integer" } } },
});

describe("tools/list shapes", () => {
  it("pass a field MCP adds later through", () => {
    expect(annotated).toHaveProperty("icons");
    expect(annotated.annotations).toHaveProperty("vendorHint", "refunds");
  });

  it("read a tools/list result with a cursor", () => {
    const result = mcpToolsListResultSchema.parse({ tools: [annotated, bare], nextCursor: "page-2" });
    expect(result.tools).toHaveLength(2);
    expect(result.nextCursor).toBe("page-2");
  });

  it("refuse an input schema whose type is not object", () => {
    const parsed = mcpToolSchema.safeParse({ name: "x", inputSchema: { type: "string" } });
    const found = parsed.error?.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    expect(found).toStrictEqual([{ path: "inputSchema.type", message: 'Invalid literal value, expected "object"' }]);
  });
});

describe("lockedMcpTool", () => {
  it("keeps the fields the model reads and the five MCP hints", () => {
    expect(lockedMcpTool(annotated)).toStrictEqual({
      name: "create_refund",
      title: "Create a refund",
      description: "Refund a charge, in full or in part.",
      inputSchema: { type: "object", properties: { charge: { type: "string" } }, required: ["charge"] },
      outputSchema: { type: "object", properties: { id: { type: "string" } } },
      annotations: { destructiveHint: true, openWorldHint: true },
    });
  });

  it("writes a value the strict locked schema accepts", () => {
    expect(lockedMcpToolSchema.safeParse(lockedMcpTool(annotated)).success).toBe(true);
  });

  it("keeps a bare tool bare", () => {
    expect(lockedMcpTool(bare)).toStrictEqual({ name: "list_charges", inputSchema: { type: "object" } });
  });

  it("locks annotations with no known hint as no annotations", () => {
    for (const annotations of [{}, { vendorHint: "refunds" }]) {
      const tool = mcpToolSchema.parse({ name: "list_charges", inputSchema: { type: "object" }, annotations });
      expect(lockedMcpTool(tool)).toStrictEqual(lockedMcpTool(bare));
    }
  });
});

describe("upstreamFromMcpTool", () => {
  it("maps an annotated tool and adds the mcp request template", () => {
    expect(upstreamFromMcpTool(annotated)).toStrictEqual({
      name: "create_refund",
      title: "Create a refund",
      description: "Refund a charge, in full or in part.",
      inputSchema: { type: "object", properties: { charge: { type: "string" } }, required: ["charge"] },
      outputSchema: { type: "object", properties: { id: { type: "string" } } },
      annotations: { destructiveHint: true, openWorldHint: true },
      request: { kind: "mcp", tool: "create_refund" },
    });
  });

  it("writes an UpstreamTool the schema accepts", () => {
    for (const tool of [annotated, bare, hyphenated]) {
      expect(upstreamToolSchema.safeParse(upstreamFromMcpTool(tool)).success).toBe(true);
    }
  });

  it("keeps a hyphenated name as the name tools/call sends, with no annotations", () => {
    const upstream = upstreamFromMcpTool(hyphenated);
    expect(upstream.name).toBe("get-issue");
    expect(upstream.request).toStrictEqual({ kind: "mcp", tool: "get-issue" });
    expect(upstream).not.toHaveProperty("annotations");
  });

  it("maps a bare tool to its name, schema, and request only", () => {
    expect(upstreamFromMcpTool(bare)).toStrictEqual({
      name: "list_charges",
      inputSchema: { type: "object" },
      request: { kind: "mcp", tool: "list_charges" },
    });
  });
});

describe("lockedUpstream", () => {
  it("pins an MCP tool as its locked tools/list entry", () => {
    for (const tool of [annotated, bare, hyphenated]) {
      expect(lockedUpstream(upstreamFromMcpTool(tool))).toStrictEqual(lockedMcpTool(tool));
    }
  });

  it("names the entry by the request's tool, not the model's name", () => {
    const renamed: UpstreamTool = {
      name: "get_issue",
      inputSchema: { type: "object" },
      request: { kind: "mcp", tool: "get-issue" },
    };
    expect(lockedUpstream(renamed)).toStrictEqual({ name: "get-issue", inputSchema: { type: "object" } });
  });

  it("pins a tool built from a definition whole", () => {
    const http: UpstreamTool = {
      name: "get_charge",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      request: {
        kind: "http",
        operation: "getCharge",
        method: "GET",
        path: "/charges/{id}",
        parameters: [{ name: "id", in: "path", property: "id", required: true }],
      },
    };
    expect(lockedUpstream(http)).toBe(http);
  });
});
