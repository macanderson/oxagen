import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
  getSurfaces: vi.fn((c: { surfaces?: readonly string[] }) => c.surfaces ?? []),
  selectResult: vi.fn(),
  whereMock: vi.fn(),
  fromMock: vi.fn(),
  selectMock: vi.fn(),
}));

mocks.whereMock.mockImplementation(
  async (): Promise<unknown> => mocks.selectResult() as unknown,
);
mocks.fromMock.mockReturnValue({ where: mocks.whereMock });
mocks.selectMock.mockReturnValue({ from: mocks.fromMock });

const fakeToolListDb = { select: mocks.selectMock };
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeToolListDb,
    withTenantDb: async (fn: (tx: typeof fakeToolListDb) => Promise<unknown>) =>
      fn(fakeToolListDb),
  };
});

// Stub @oxagen/oxagen so the dynamic import inside the handler resolves
vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: mocks.listCapabilities,
  getSurfaces: mocks.getSurfaces,
  // getOxagenRegistry() reads getCapability off the module; the mock must define
  // it (agent.tool.list doesn't use it, but the registry loader reads it eagerly).
  getCapability: () => undefined,
}));

// Entitlement filter dependencies (WP4): pluginForContract maps a capability
// name to the plugin that claims it; listEntitledCapabilityPluginIds returns
// the org's installed+enabled capability-plugin ids.
vi.mock("@oxagen/oxagen/plugins", () => ({
  pluginForContract: vi.fn((_name: string) => undefined),
}));

vi.mock("@oxagen/plugins", () => ({
  listEntitledCapabilityPluginIds: vi.fn(
    async (_orgId: string, _workspaceId: string) => new Set<string>(),
  ),
}));

import { agentToolListHandler } from "./agent.tool.list";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

const BUILTIN_CAP = {
  name: "generate_document",
  description: "Generates a document",
  domain: "documents",
  agent: {
    riskLevel: "low" as const,
    category: "documents",
    requiresApproval: false,
  },
  surfaces: ["api", "mcp", "agent"] as const,
};

describe("agent.tool.list handler", () => {
  beforeEach(() => {
    mocks.listCapabilities.mockClear();
    mocks.selectMock.mockClear();
    mocks.selectResult.mockClear();
    mocks.getSurfaces.mockImplementation(
      (c: { surfaces?: readonly string[] }) => c.surfaces ?? [],
    );
  });

  it("returns only builtin agent-surface tools when includeExternal is false", async () => {
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("generate_document");
    expect(result.tools[0]!.external).toBe(false);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it("filters out capabilities not on the agent surface", async () => {
    const apiOnly = {
      ...BUILTIN_CAP,
      name: "billing.query",
      surfaces: ["api"] as const,
    };
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP, apiOnly]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("generate_document");
  });

  it("appends external tools from mcp_servers when includeExternal is true", async () => {
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP]);
    mocks.selectResult.mockReturnValueOnce([
      { name: "my-mcp", discoveredTools: ["remote_tool"] },
    ]);

    const result = await agentToolListHandler({ includeExternal: true }, CTX);

    expect(result.tools).toHaveLength(2);
    const ext = result.tools.find((t) => t.external);
    expect(ext).toBeDefined();
    expect(ext!.name).toBe("my-mcp.remote_tool");
    expect(ext!.requiresApproval).toBe(true);
    expect(ext!.riskLevel).toBe("medium");
  });

  it("handles mcp_servers rows where discoveredTools is not an array", async () => {
    mocks.listCapabilities.mockReturnValueOnce([]);
    mocks.selectResult.mockReturnValueOnce([
      { name: "broken-server", discoveredTools: null },
    ]);

    const result = await agentToolListHandler({ includeExternal: true }, CTX);

    expect(result.tools).toHaveLength(0);
  });

  it("returns empty list when no builtin or external tools match", async () => {
    mocks.listCapabilities.mockReturnValueOnce([]);
    mocks.selectResult.mockReturnValueOnce([]);

    const result = await agentToolListHandler({ includeExternal: true }, CTX);

    expect(result.tools).toEqual([]);
  });
});

describe("agent.tool.list handler — entitlement filter (WP4)", () => {
  const PLUGIN_MANIFEST = {
    id: "oxagen/media-svg",
    name: "SVG Generation",
    description: "Generate SVGs",
    version: "1.0.0",
    pluginType: "agent_capability" as const,
    tier: "free" as const,
    visibility: "ga" as const,
    category: "media",
    contracts: ["media.svg.generate"],
    scopes: [],
  };

  const CLAIMED_CAP = {
    ...BUILTIN_CAP,
    name: "media.svg.generate",
    description: "Generates an SVG",
    domain: "media",
  };

  beforeEach(() => {
    mocks.listCapabilities.mockClear();
    mocks.selectMock.mockClear();
    mocks.selectResult.mockClear();
    mocks.getSurfaces.mockImplementation(
      (c: { surfaces?: readonly string[] }) => c.surfaces ?? [],
    );
    vi.mocked(pluginForContract).mockClear();
    vi.mocked(listEntitledCapabilityPluginIds).mockClear();
    // Default: pluginForContract returns undefined (all builtins).
    vi.mocked(pluginForContract).mockReturnValue(undefined);
    // Default: empty entitled set.
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set<string>(),
    );
  });

  it("includes plugin-claimed capability when org is entitled to the pack", async () => {
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "media.svg.generate" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set(["oxagen/media-svg"]),
    );
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP, CLAIMED_CAP]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    expect(result.tools.map((t) => t.name)).toEqual([
      "generate_document",
      "media.svg.generate",
    ]);
  });

  it("excludes plugin-claimed capability when org is NOT entitled; builtins still listed", async () => {
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "media.svg.generate" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set<string>(),
    );
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP, CLAIMED_CAP]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    expect(result.tools.map((t) => t.name)).toEqual(["generate_document"]);
  });

  it("leaves builtin capabilities unaffected regardless of entitlement state", async () => {
    // All capabilities are builtins (pluginForContract returns undefined);
    // the entitlement service must never be consulted.
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    expect(result.tools.map((t) => t.name)).toEqual(["generate_document"]);
    expect(listEntitledCapabilityPluginIds).not.toHaveBeenCalled();
  });

  it("excludes plugin-claimed tools and keeps builtins when entitlement fetch throws (fail-closed)", async () => {
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "media.svg.generate" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockRejectedValue(
      new Error("DB unavailable"),
    );
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP, CLAIMED_CAP]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    // Plugin-claimed tool is excluded (fail-closed); builtins unaffected; no throw.
    expect(result.tools.map((t) => t.name)).toEqual(["generate_document"]);
  });

  it("fetches the entitled set at most once per handler invocation", async () => {
    const PLUGIN_B = {
      ...PLUGIN_MANIFEST,
      id: "oxagen/other",
      contracts: ["generate_document"],
    };
    vi.mocked(pluginForContract).mockImplementation((name: string) => {
      if (name === "media.svg.generate") return PLUGIN_MANIFEST;
      if (name === "generate_document") return PLUGIN_B;
      return undefined;
    });
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set(["oxagen/media-svg", "oxagen/other"]),
    );
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP, CLAIMED_CAP]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    // Both capabilities are plugin-claimed and entitled, but the entitlement
    // service is called exactly once per handler invocation.
    expect(result.tools).toHaveLength(2);
    expect(listEntitledCapabilityPluginIds).toHaveBeenCalledTimes(1);
    expect(listEntitledCapabilityPluginIds).toHaveBeenCalledWith(
      CTX.orgId,
      CTX.workspaceId,
    );
  });
});
