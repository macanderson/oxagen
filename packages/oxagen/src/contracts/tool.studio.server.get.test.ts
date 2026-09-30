/**
 * Contract test for get_studio_server (#4678, part 3).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioServerGet } from "./tool.studio.server.get";

/** list_studio_tools' catalog for the ledger folder, with no tools. */
const catalog = {
  server: "ledger",
  mcpServerId: "mcs_1",
  snapshotId: null,
  capturedAt: null,
  exposure: { mode: "direct", budget: 8000 },
  tokens: { definitions: 0, budget: 8000 },
  imported: 0,
  offered: 0,
  searchRecommended: false,
  compileError: null,
  tools: [],
} as const;

const output = {
  ...catalog,
  folder: "tools/servers/ledger",
  label: "Ledger",
  description: "Entries in the finance ledger.",
  source: {
    type: "remote",
    url: "https://ledger.example/mcp",
    transport: "http",
    network: null,
  },
  auth: {
    mode: "service",
    scheme: "bearer",
    credential: "oxagen:credential/ledger",
  },
  environments: [
    {
      name: "sandbox",
      sandbox: true,
      url: "https://sandbox.ledger.example/mcp",
      network: "relay:finance",
      credential: "oxagen:credential/ledger-sandbox",
    },
  ],
  sync: { schedule: "daily", lastAt: "2026-09-29T10:00:00.000Z" },
  shaping: [
    {
      tool: "search",
      hide: ["account"],
      fixed: [{ name: "limit", value: "25" }],
      select: ["entries"],
      selection: null,
    },
  ],
} as const;

describe("get_studio_server is registered as declared", () => {
  it("is scoped, reads only, and skips the billing gate", () => {
    const cap = getCapability("get_studio_server");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
  });

  it("lets a workspace viewer read", () => {
    const cap = getCapability("get_studio_server");
    expect(cap?.defaultRoles?.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });
});

describe("get_studio_server", () => {
  it("accepts a server name and refuses anything else", () => {
    expect(toolStudioServerGet.input.parse({ server: "ledger" })).toEqual({
      server: "ledger",
    });
    for (const input of [
      {},
      { server: "Ledger" },
      { server: "builtin" },
      { server: "ledger", serverId: "mcs_1" },
    ]) {
      expect(toolStudioServerGet.input.safeParse(input).success).toBe(false);
    }
  });

  it("returns the folder beside the catalog", () => {
    expect(toolStudioServerGet.output.parse(output)).toEqual(output);
  });

  it.each([
    {
      type: "registry",
      registry: "https://registry.modelcontextprotocol.io",
      server: "io.github.acme/files",
      version: "1.2.0",
      network: null,
      machines: ["dev-laptops"],
      registryType: "npm",
      env: ["ACME_TOKEN"],
    },
    {
      type: "local",
      command: "npx",
      args: ["-y", "@acme/files"],
      env: ["ACME_TOKEN"],
      machines: ["dev-laptops"],
    },
    {
      type: "graphql",
      from: "introspection",
      repo: null,
      path: null,
      ref: null,
      url: null,
      network: null,
    },
  ])("takes a $type source", (source) => {
    expect(
      toolStudioServerGet.output.safeParse({ ...output, source }).success,
    ).toBe(true);
  });

  it("refuses the catalog alone, an unknown auth mode, or an unknown schedule", () => {
    expect(toolStudioServerGet.output.safeParse(catalog).success).toBe(false);
    expect(
      toolStudioServerGet.output.safeParse({
        ...output,
        auth: { ...output.auth, mode: "password" },
      }).success,
    ).toBe(false);
    expect(
      toolStudioServerGet.output.safeParse({
        ...output,
        sync: { schedule: "hourly", lastAt: null },
      }).success,
    ).toBe(false);
  });
});
