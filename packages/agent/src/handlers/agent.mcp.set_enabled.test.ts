/**
 * Regression coverage: re-enabling a server must re-probe with
 * the DECRYPTED secret, not the raw envelope-encrypted (or ciphertext) value.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selectWhere: vi.fn(),
  updateWhere: vi.fn(),
  healthcheckMock: vi.fn(),
}));

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: mocks.selectWhere,
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: mocks.updateWhere,
    }),
  }),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
});

vi.mock("../dispatch/mcp-client", () => ({
  healthcheck: mocks.healthcheckMock,
}));

vi.mock("../runtime/mcp-snapshots", () => ({
  captureToolSnapshots: vi.fn(async () => 0),
  recordServerChange: vi.fn(async () => undefined),
}));

import { agentMcpSetEnabledHandler } from "./agent.mcp.set_enabled";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.mcp.set_enabled handler — auth_config decryption", () => {
  const originalKey = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

  beforeEach(() => {
    mocks.selectWhere.mockReset();
    mocks.updateWhere.mockReset().mockResolvedValue(undefined);
    mocks.healthcheckMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.AUTH_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("decrypts an encrypted auth_config before re-probing on enable", async () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptMcpAuthConfig } = await import(
      "../runtime/mcp-server-auth-crypto"
    );
    const encrypted = await encryptMcpAuthConfig({ token: "re-probe-secret" });

    mocks.selectWhere.mockResolvedValue([
      {
        id: "mcs_uuid_1",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.example.com",
        authStrategy: "bearer",
        authConfig: encrypted,
      },
    ]);
    mocks.healthcheckMock.mockResolvedValue({
      status: "healthy",
      discoveredTools: [],
      descriptors: [],
    });

    await agentMcpSetEnabledHandler(
      { mcpServerId: "mcp_pub_1", enabled: true },
      CTX,
    );

    expect(mocks.healthcheckMock).toHaveBeenCalledWith({
      endpointUrl: "https://mcp.example.com",
      authStrategy: "bearer",
      authConfig: { token: "re-probe-secret" },
    });
  });

  it("passes an empty auth_config straight through with no key required", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    mocks.selectWhere.mockResolvedValue([
      {
        id: "mcs_uuid_2",
        transportType: "streamable-http",
        endpointUrl: "https://mcp2.example.com",
        authStrategy: "none",
        authConfig: {},
      },
    ]);
    mocks.healthcheckMock.mockResolvedValue({
      status: "healthy",
      discoveredTools: [],
      descriptors: [],
    });

    await agentMcpSetEnabledHandler(
      { mcpServerId: "mcp_pub_2", enabled: true },
      CTX,
    );

    expect(mocks.healthcheckMock).toHaveBeenCalledWith({
      endpointUrl: "https://mcp2.example.com",
      authStrategy: "none",
      authConfig: {},
    });
  });
});
