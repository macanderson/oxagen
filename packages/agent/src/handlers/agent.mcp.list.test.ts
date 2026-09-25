import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selectResult: vi.fn(),
  whereMock: vi.fn(),
  fromMock: vi.fn(),
  selectMock: vi.fn(),
}));

// Rows written before #4132's joins carry no listing or credential columns;
// the join leaves them null and the static strategy stands.
mocks.whereMock.mockImplementation(async (): Promise<unknown> => {
  const rows = mocks.selectResult() as Record<string, unknown>[] | undefined;
  return rows?.map((row) => ({ authStrategy: "none", ...row }));
});
const joined = {
  leftJoin: (): unknown => joined,
  where: mocks.whereMock,
};
mocks.fromMock.mockReturnValue(joined);
mocks.selectMock.mockReturnValue({ from: mocks.fromMock });

const fakeMcpListDb = { select: mocks.selectMock };
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => fakeMcpListDb,
    withTenantDb: async (fn: (tx: typeof fakeMcpListDb) => Promise<unknown>) =>
      fn(fakeMcpListDb),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  agentMcpListHandler,
  authorizationOf,
  McpServerRowInvalidError,
} from "./agent.mcp.list";
import { agentMcpList } from "@oxagen/oxagen/contracts/agent.mcp.list";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

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

  it("redacts userinfo from a stored endpoint address (#3720)", async () => {
    // A row written before the register guard can carry a username and
    // password in endpoint_url. The list must not return either in the clear.
    mocks.selectResult.mockReturnValueOnce([
      {
        publicId: "mcp_4",
        name: "legacy-server",
        transportType: "streamable-http",
        endpointUrl: "https://admin:hunter2@mcp.example.com/mcp",
        healthStatus: "healthy",
        lastHealthcheckAt: null,
        discoveredTools: [],
      },
      {
        publicId: "mcp_5",
        name: "key-in-username",
        transportType: "sse",
        endpointUrl: "https://sk-live-secret@mcp.example.com/sse",
        healthStatus: "unknown",
        lastHealthcheckAt: null,
        discoveredTools: [],
      },
    ]);
    const result = await agentMcpListHandler({}, CTX);
    const [withPassword, withKey] = result.servers;
    expect(withPassword!.endpointUrl).toBe("https://***@mcp.example.com/mcp");
    expect(withKey!.endpointUrl).toBe("https://***@mcp.example.com/sse");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("admin");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk-live-secret");
    expect(agentMcpList.output.safeParse(result).success).toBe(true);
  });

  it("returns a plugin-installed row (sse, unknown) that the contract output accepts", async () => {
    // plugin.set_enabled.ts inserts freshly enabled servers with transport
    // 'sse' and health 'unknown'. The kernel parses handler output against
    // the contract, so a row like this must survive that parse.
    mocks.selectResult.mockReturnValueOnce([
      {
        publicId: "mcp_3",
        name: "plugin-server",
        transportType: "sse",
        endpointUrl: "https://mcp.example.com/sse",
        healthStatus: "unknown",
        lastHealthcheckAt: null,
        discoveredTools: [],
      },
    ]);
    const result = await agentMcpListHandler({}, CTX);
    const parsed = agentMcpList.output.parse(result);
    expect(parsed.servers[0]!.transportType).toBe("sse");
    expect(parsed.servers[0]!.healthStatus).toBe("unknown");
  });

  it("rejects a row whose discoveredTools is not a list instead of reporting 0", async () => {
    mocks.selectResult.mockReturnValueOnce([
      {
        publicId: "mcp_2",
        name: "bad-server",
        transportType: "stdio",
        endpointUrl: "stdio://bad",
        healthStatus: "unreachable",
        lastHealthcheckAt: null,
        discoveredTools: null,
      },
    ]);
    const err = await agentMcpListHandler({}, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpServerRowInvalidError);
    expect((err as McpServerRowInvalidError).code).toBe(
      "mcp_server_row_invalid",
    );
    expect((err as Error).message).toContain("mcp_2");
    expect((err as Error).message).toContain("discovered_tools");
  });

  it("rejects a row whose transportType is outside the contract enum", async () => {
    mocks.selectResult.mockReturnValueOnce([
      {
        publicId: "mcp_4",
        name: "odd-transport",
        transportType: "websocket",
        endpointUrl: "wss://mcp.example.com",
        healthStatus: "healthy",
        lastHealthcheckAt: null,
        discoveredTools: [],
      },
    ]);
    const err = await agentMcpListHandler({}, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpServerRowInvalidError);
    expect((err as Error).message).toContain("transport_type");
    expect((err as Error).message).toContain("websocket");
  });

  it("rejects a row whose healthStatus is outside the contract enum", async () => {
    mocks.selectResult.mockReturnValueOnce([
      {
        publicId: "mcp_5",
        name: "odd-health",
        transportType: "stdio",
        endpointUrl: "stdio://odd",
        healthStatus: "pending",
        lastHealthcheckAt: null,
        discoveredTools: [],
      },
    ]);
    const err = await agentMcpListHandler({}, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpServerRowInvalidError);
    expect((err as Error).message).toContain("health_status");
    expect((err as Error).message).toContain("pending");
  });

  it("scopes query to orgId and workspaceId from context (tenant isolation)", async () => {
    mocks.selectResult.mockReturnValue([]);
    const beforeWhere = mocks.whereMock.mock.calls.length;
    await agentMcpListHandler({}, CTX);
    expect(mocks.whereMock.mock.calls.length - beforeWhere).toBe(1);
  });

  describe("authorization (#4132)", () => {
    const base = {
      publicId: "mcs_1",
      authStrategy: "bearer",
      listingAuthKind: "oauth",
      iconUrl: "https://linear.app/favicon.ico",
      credentialStatus: "active",
      hasAccessToken: true,
      hasRefreshToken: true,
      expiresAt: new Date("2026-09-25T00:00:00Z"),
      lastRefreshedAt: new Date("2026-09-24T00:00:00Z"),
    };

    it("reports a held token as connected, with its expiry and refresh", () => {
      expect(authorizationOf(base)).toEqual({
        authKind: "oauth",
        iconUrl: "https://linear.app/favicon.ico",
        authorization: {
          state: "connected",
          expiresAt: "2026-09-25T00:00:00.000Z",
          refreshable: true,
          lastRefreshedAt: "2026-09-24T00:00:00.000Z",
        },
      });
    });

    it("reports needs_reauth and revoked as stored, whatever token is held", () => {
      expect(
        authorizationOf({ ...base, credentialStatus: "needs_reauth" })
          .authorization?.state,
      ).toBe("needs_reauth");
      expect(
        authorizationOf({ ...base, credentialStatus: "revoked" }).authorization
          ?.state,
      ).toBe("revoked");
    });

    it("reports an OAuth listing with no token as not connected", () => {
      const out = authorizationOf({
        ...base,
        credentialStatus: null,
        hasAccessToken: null,
        hasRefreshToken: null,
        expiresAt: null,
        lastRefreshedAt: null,
      });
      expect(out.authorization).toEqual({
        state: "not_connected",
        expiresAt: null,
        refreshable: false,
        lastRefreshedAt: null,
      });
    });

    it("reports a static strategy with no authorization, and drops a non-https icon", () => {
      expect(
        authorizationOf({
          ...base,
          listingAuthKind: null,
          authStrategy: "header",
          iconUrl: "http://example.com/i.png",
        }),
      ).toEqual({ authKind: "header", iconUrl: null, authorization: null });
    });

    it("maps a joined OAuth row through the handler", async () => {
      mocks.selectResult.mockReturnValueOnce([
        {
          ...base,
          name: "Linear",
          transportType: "streamable-http",
          endpointUrl: "https://mcp.linear.app/mcp",
          healthStatus: "healthy",
          lastHealthcheckAt: null,
          discoveredTools: ["list_issues"],
        },
      ]);
      const result = await agentMcpListHandler({}, CTX);
      expect(
        agentMcpList.output.parse(result).servers[0]?.authorization?.state,
      ).toBe("connected");
    });
  });
});
