import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  insertValues: vi.fn(),
  insertSpy: vi.fn(),
  healthcheckMock: vi.fn(),
}));

// The handler's .returning() now yields { id, publicId } (id feeds the snapshot
// capture). Capture snapshots is mocked so we can assert it without a DB.
mocks.insertReturning.mockResolvedValue([
  { id: "mcs_uuid_1", publicId: "mcp_pub_1" },
]);
mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
mocks.insertSpy.mockReturnValue({ values: mocks.insertValues });

const fakeDb = { insert: mocks.insertSpy };

const captureSnapshotsMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
});

vi.mock("../dispatch/mcp-client", () => ({
  healthcheck: mocks.healthcheckMock,
}));

vi.mock("../runtime/mcp-snapshots", () => ({
  captureToolSnapshots: captureSnapshotsMock,
}));

import { agentMcpRegisterHandler } from "./agent.mcp.register";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

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
    captureSnapshotsMock.mockClear();
    mocks.insertReturning.mockResolvedValue([
      { id: "mcs_uuid_1", publicId: "mcp_pub_1" },
    ]);
  });

  it("runs healthcheck for streamable-http transport and inserts the row", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({
      status: "healthy",
      discoveredTools: ["tool_a", "tool_b"],
      descriptors: [
        { name: "tool_a", description: null, inputSchema: {} },
        { name: "tool_b", description: null, inputSchema: {} },
      ],
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

  it("captures a tool-descriptor snapshot per discovered tool", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({
      status: "healthy",
      discoveredTools: ["tool_a"],
      descriptors: [
        { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      ],
    });

    await agentMcpRegisterHandler(BASE_INPUT, CTX);

    expect(captureSnapshotsMock).toHaveBeenCalledTimes(1);
    const arg = (
      captureSnapshotsMock.mock.calls[0] as unknown as [
        {
          mcpServerId: string;
          descriptors: unknown[];
        },
      ]
    )[0];
    expect(arg.mcpServerId).toBe("mcs_uuid_1");
    expect(arg.descriptors).toHaveLength(1);
  });

  it("does not capture snapshots when no tools are discovered", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({
      status: "healthy",
      discoveredTools: [],
      descriptors: [],
    });
    await agentMcpRegisterHandler(BASE_INPUT, CTX);
    expect(captureSnapshotsMock).not.toHaveBeenCalled();
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
    mocks.healthcheckMock.mockResolvedValueOnce({
      status: "healthy",
      discoveredTools: [],
      descriptors: [],
    });
    mocks.insertReturning.mockResolvedValueOnce([]);

    await expect(agentMcpRegisterHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "mcp_servers insert failed",
    );
  });

  it("inserts row with orgId and workspaceId scoped from context (tenant isolation)", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({
      status: "healthy",
      discoveredTools: [],
      descriptors: [],
    });

    await agentMcpRegisterHandler(BASE_INPUT, CTX);

    const valuesArg = mocks.insertValues.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(valuesArg.orgId).toBe("org_1");
    expect(valuesArg.workspaceId).toBe("ws_1");
  });

  // ── SSRF guard ────────────────────────────────────────────────────────────
  it.each([
    ["http://localhost:8080/mcp", "localhost"],
    ["http://127.0.0.1/mcp", "loopback IPv4"],
    ["http://10.1.2.3/mcp", "RFC1918 class A"],
    ["http://172.16.0.5/mcp", "RFC1918 class B"],
    ["http://192.168.1.1/mcp", "RFC1918 class C"],
    ["http://169.254.169.254/latest/meta-data/", "cloud-metadata link-local"],
    ["http://[::1]/mcp", "IPv6 loopback"],
    ["ftp://mcp.example.com/", "non-http scheme"],
  ])(
    "rejects internal/private endpoint %s (%s) before any outbound probe",
    async (url) => {
      const input = { ...BASE_INPUT, endpointUrl: url };

      await expect(agentMcpRegisterHandler(input, CTX)).rejects.toThrow(
        /Refusing to register MCP server/,
      );
      // The guard must fire before the network probe and before any DB write.
      expect(mocks.healthcheckMock).not.toHaveBeenCalled();
      expect(mocks.insertSpy).not.toHaveBeenCalled();
    },
  );

  it("allows a publicly routable https endpoint", async () => {
    mocks.healthcheckMock.mockResolvedValueOnce({
      status: "healthy",
      discoveredTools: [],
      descriptors: [],
    });
    const input = {
      ...BASE_INPUT,
      endpointUrl: "https://mcp.public-host.com/mcp",
    };

    const result = await agentMcpRegisterHandler(input, CTX);

    expect(mocks.healthcheckMock).toHaveBeenCalledTimes(1);
    expect(result.mcpServerId).toBe("mcp_pub_1");
  });

  // ── auth_config is envelope-encrypted before it reaches the DB ──
  describe("auth_config encryption", () => {
    const originalKey = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    const TEST_KEY = Buffer.alloc(32, 3).toString("base64");

    afterEach(() => {
      if (originalKey === undefined)
        delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
      else process.env.AUTH_TOKEN_ENCRYPTION_KEY = originalKey;
    });

    it("stores auth_config encrypted — the raw secret never reaches the insert values", async () => {
      process.env.AUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
      mocks.healthcheckMock.mockResolvedValueOnce({
        status: "healthy",
        discoveredTools: [],
        descriptors: [],
      });

      const input = {
        ...BASE_INPUT,
        authStrategy: "bearer" as const,
        authConfig: { token: "definitely-not-plaintext-in-db-9f8e7d" },
      };

      await agentMcpRegisterHandler(input, CTX);

      const valuesArg = mocks.insertValues.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      // The persisted value must not equal the plaintext record, and must not
      // contain the secret substring anywhere in its serialized form.
      expect(valuesArg.authConfig).not.toEqual(input.authConfig);
      expect(JSON.stringify(valuesArg.authConfig)).not.toContain(
        "definitely-not-plaintext-in-db-9f8e7d",
      );
      // It must be the documented encrypted envelope shape.
      expect(valuesArg.authConfig).toMatchObject({
        v: 1,
        kmsKeyId: expect.any(String),
      });
      expect(
        typeof (valuesArg.authConfig as { ciphertext: string }).ciphertext,
      ).toBe("string");

      // The live healthcheck probe still uses the RAW plaintext (needed to
      // actually connect) — only the persisted row is encrypted.
      expect(mocks.healthcheckMock).toHaveBeenCalledWith({
        endpointUrl: input.endpointUrl,
        authStrategy: input.authStrategy,
        authConfig: input.authConfig,
      });
    });

    it("stores {} for authStrategy 'none' with no authConfig — no key required", async () => {
      delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
      mocks.healthcheckMock.mockResolvedValueOnce({
        status: "healthy",
        discoveredTools: [],
        descriptors: [],
      });

      await agentMcpRegisterHandler(BASE_INPUT, CTX);

      const valuesArg = mocks.insertValues.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(valuesArg.authConfig).toEqual({});
    });

    it("refuses to register a secret-bearing server when AUTH_TOKEN_ENCRYPTION_KEY is unset (fail-closed, never persists plaintext)", async () => {
      delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
      mocks.healthcheckMock.mockResolvedValueOnce({
        status: "healthy",
        discoveredTools: [],
        descriptors: [],
      });

      const input = {
        ...BASE_INPUT,
        authStrategy: "bearer" as const,
        authConfig: { token: "would-be-plaintext" },
      };

      await expect(agentMcpRegisterHandler(input, CTX)).rejects.toThrow(
        /AUTH_TOKEN_ENCRYPTION_KEY/,
      );
      expect(mocks.insertSpy).not.toHaveBeenCalled();
    });
  });
});
