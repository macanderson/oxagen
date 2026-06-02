import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
  getSurfaces: vi.fn((c: { surfaces?: readonly string[] }) => c.surfaces ?? []),
  selectResult: vi.fn(),
  whereMock: vi.fn(),
  fromMock: vi.fn(),
  selectMock: vi.fn(),
}));

mocks.whereMock.mockImplementation(async (): Promise<unknown> => mocks.selectResult() as unknown);
mocks.fromMock.mockReturnValue({ where: mocks.whereMock });
mocks.selectMock.mockReturnValue({ from: mocks.fromMock });

vi.mock("@oxagen/database", () => ({
  db: () => ({ select: mocks.selectMock }),
  schema: {
    mcpServers: {
      name: "name",
      discoveredTools: "discoveredTools",
      orgId: "orgId",
      workspaceId: "workspaceId",
    },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { and: orig.and, eq: orig.eq };
});

// Stub @oxagen/oxagen so the dynamic import inside the handler resolves
vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: mocks.listCapabilities,
  getSurfaces: mocks.getSurfaces,
}));

import { agentToolListHandler } from "./agent.tool.list";

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

const BUILTIN_CAP = {
  name: "documents.generate",
  description: "Generates a document",
  domain: "documents",
  agent: { riskLevel: "low" as const, category: "documents", requiresApproval: false },
  surfaces: ["api", "mcp", "agent"] as const,
};

describe("agent.tool.list handler", () => {
  beforeEach(() => {
    mocks.listCapabilities.mockClear();
    mocks.selectMock.mockClear();
    mocks.selectResult.mockClear();
    mocks.getSurfaces.mockImplementation((c: { surfaces?: readonly string[] }) => c.surfaces ?? []);
  });

  it("returns only builtin agent-surface tools when includeExternal is false", async () => {
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("documents.generate");
    expect(result.tools[0]!.external).toBe(false);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it("filters out capabilities not on the agent surface", async () => {
    const apiOnly = { ...BUILTIN_CAP, name: "billing.query", surfaces: ["api"] as const };
    mocks.listCapabilities.mockReturnValueOnce([BUILTIN_CAP, apiOnly]);

    const result = await agentToolListHandler({ includeExternal: false }, CTX);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("documents.generate");
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
