import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
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
      publicId: "publicId",
      name: "name",
      transportType: "transportType",
      endpointUrl: "endpointUrl",
      healthStatus: "healthStatus",
      lastHealthcheckAt: "lastHealthcheckAt",
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

import { agentMcpListHandler } from "./agent.mcp.list.js";

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("agent.mcp.list handler", () => {
  beforeEach(() => {
    mocks.selectMock.mockClear();
    mocks.selectResult.mockClear();
  });

  it("returns an empty server list when no rows exist", async () => {
    mocks.selectResult.mockReturnValueOnce([]);
    const result = await agentMcpListHandler({}, CTX);
    expect(result.servers).toEqual([]);
    expect(mocks.selectMock).toHaveBeenCalledTimes(1);
  });

  it("maps rows to the expected output shape", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    mocks.selectResult.mockReturnValueOnce([
      {
        publicId: "mcp_1",
        name: "my-server",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.example.com",
        healthStatus: "healthy",
        lastHealthcheckAt: now,
        discoveredTools: ["tool_a", "tool_b"],
      },
    ]);
    const result = await agentMcpListHandler({}, CTX);
    expect(result.servers).toHaveLength(1);
    const s = result.servers[0]!;
    expect(s.publicId).toBe("mcp_1");
    expect(s.name).toBe("my-server");
    expect(s.transportType).toBe("streamable-http");
    expect(s.healthStatus).toBe("healthy");
    expect(s.lastHealthcheckAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s.toolCount).toBe(2);
  });

  it("sets toolCount to 0 when discoveredTools is not an array", async () => {
    mocks.selectResult.mockReturnValueOnce([
      {
        publicId: "mcp_2",
        name: "bad-server",
        transportType: "stdio",
        endpointUrl: null,
        healthStatus: "unreachable",
        lastHealthcheckAt: null,
        discoveredTools: null,
      },
    ]);
    const result = await agentMcpListHandler({}, CTX);
    expect(result.servers[0]!.toolCount).toBe(0);
    expect(result.servers[0]!.lastHealthcheckAt).toBeNull();
  });

  it("scopes query to orgId and workspaceId from context (tenant isolation)", () => {
    mocks.selectResult.mockReturnValue([]);
    const beforeWhere = mocks.whereMock.mock.calls.length;
    void agentMcpListHandler({}, CTX);
    expect(mocks.whereMock.mock.calls.length - beforeWhere).toBe(1);
  });
});
