import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  insertValues: vi.fn(),
  insertSpy: vi.fn(),
  healthcheckMock: vi.fn(),
}));

mocks.insertReturning.mockResolvedValue([{ publicId: "mcp_pub_1" }]);
mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
mocks.insertSpy.mockReturnValue({ values: mocks.insertValues });

const fakeDb = { insert: mocks.insertSpy };

vi.mock("@oxagen/database", () => ({
  db: () => fakeDb,
  withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) => fn(fakeDb),
  schema: {
    mcpServers: {
      publicId: "publicId",
    },
  },
}));

vi.mock("../dispatch/mcp-client", () => ({
  healthcheck: mocks.healthcheckMock,
}));

import { agentMcpRegisterHandler } from "./agent.mcp.register";

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

const BASE_INPUT = {
  name: "test-mcp",
  transportType: "streamable-http" as const,
  endpointUrl: "https://mcp.example.com",
  authStrategy: "none" as const,
  authConfig: undefined,
};

describe("agent.mcp.register handler", () => {
  beforeEach(() => {
    mocks.insertSpy.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertReturning.mockClear();
    mocks.healthcheckMock.mockClear();
    mocks.insertReturning.mockResolvedValue([{ publicId: "mcp_pub_1" }]);
  });

  it("runs healthcheck for streamable-http transport and inserts the row", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({
      status: "healthy",
      discoveredTools: ["tool_a", "tool_b"],
    });

    const result = await agentMcpRegisterHandler(BASE_INPUT, CTX);

    expect(mocks.healthcheckMock).toHaveBeenCalledTimes(1);
    expect(mocks.healthcheckMock).toHaveBeenCalledWith({
      endpointUrl: BASE_INPUT.endpointUrl,
      authStrategy: BASE_INPUT.authStrategy,
      authConfig: BASE_INPUT.authConfig,
    });
    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
    expect(result.mcpServerId).toBe("mcp_pub_1");
    expect(result.healthStatus).toBe("healthy");
    expect(result.discoveredTools).toEqual(["tool_a", "tool_b"]);
  });

  it("skips healthcheck for non-http transport and inserts with degraded status", async () => {
    const input = { ...BASE_INPUT, transportType: "stdio" as const };

    const result = await agentMcpRegisterHandler(input, CTX);

    expect(mocks.healthcheckMock).not.toHaveBeenCalled();
    expect(result.healthStatus).toBe("degraded");
    expect(result.discoveredTools).toEqual([]);
    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when the insert returns no row", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({ status: "healthy", discoveredTools: [] });
    mocks.insertReturning.mockResolvedValueOnce([]);

    await expect(agentMcpRegisterHandler(BASE_INPUT, CTX)).rejects.toThrow("mcp_servers insert failed");
  });

  it("inserts row with orgId and workspaceId scoped from context (tenant isolation)", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({ status: "healthy", discoveredTools: [] });

    await agentMcpRegisterHandler(BASE_INPUT, CTX);

    const valuesArg = mocks.insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg.orgId).toBe("org_1");
    expect(valuesArg.workspaceId).toBe("ws_1");
  });
});
