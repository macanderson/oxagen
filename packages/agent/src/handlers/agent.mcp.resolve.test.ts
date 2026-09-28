import { describe, expect, it, vi, beforeEach } from "vitest";

// Chained query-builder mock: select().from().innerJoin().where() → rows.
const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  whereMock: vi.fn(),
  innerJoinMock: vi.fn(),
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  getWorkspaceSecret: vi.fn(),
  decryptMcpAuthConfig: vi.fn(),
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));

mocks.whereMock.mockImplementation(
  async (): Promise<unknown> => mocks.rows() as unknown,
);
mocks.innerJoinMock.mockReturnValue({ where: mocks.whereMock });
mocks.fromMock.mockReturnValue({ innerJoin: mocks.innerJoinMock });
mocks.selectMock.mockReturnValue({ from: mocks.fromMock });

const fakeDb = { select: mocks.selectMock };
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// The role gate reads Postgres; the suite decides its answer (#3490).
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
}));

vi.mock("@oxagen/plugins", () => ({
  getWorkspaceSecret: mocks.getWorkspaceSecret,
}));

vi.mock("../runtime/mcp-server-auth-crypto", () => ({
  decryptMcpAuthConfig: mocks.decryptMcpAuthConfig,
}));

import { agentMcpResolveHandler } from "./agent.mcp.resolve";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

function row(overrides: Record<string, unknown> = {}) {
  return {
    publicId: "mcp_1",
    name: "github",
    endpointUrl: "https://mcp.example.com",
    transportType: "streamable-http",
    authStrategy: "bearer",
    authConfig: {},
    orgListingId: "listing_1",
    authKind: "secret",
    ...overrides,
  };
}

describe("agent.mcp.resolve handler", () => {
  beforeEach(() => {
    mocks.rows.mockReset();
    mocks.getWorkspaceSecret.mockReset();
    mocks.decryptMcpAuthConfig.mockReset();
    mocks.decryptMcpAuthConfig.mockResolvedValue({});
    mocks.assertOrgRole.mockReset();
    mocks.assertOrgRole.mockResolvedValue("Member");
    mocks.resolveActingUserId.mockReset();
    mocks.resolveActingUserId.mockImplementation(
      async (ctx: { userId: string | null }) => ctx.userId,
    );
  });

  // #3490: the contract grants org Owner/Admin and workspace Owner/Member,
  // and the kernel's IAM check allows every call below the enterprise tier,
  // so only this gate keeps a workspace Viewer from reading every token.
  it("asserts the contract's roles for the acting user before any read", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("creator_1");
    mocks.rows.mockReturnValueOnce([]);
    await agentMcpResolveHandler({}, { ...CTX, userId: null, apiKeyId: "k" });
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId, userId: "creator_1" }),
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
  });

  it("refuses a caller outside those roles and reads nothing", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(
      Object.assign(new Error("org role required"), {
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    await expect(agentMcpResolveHandler({}, CTX)).rejects.toMatchObject({
      reason: "org_role_required",
    });
    expect(mocks.selectMock).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("returns [] with no workspace in context", async () => {
    const out = await agentMcpResolveHandler({}, { ...CTX, workspaceId: "" });
    expect(out.servers).toEqual([]);
  });

  it("resolves a secret/bearer server's token from the workspace credential", async () => {
    mocks.rows.mockReturnValueOnce([row()]);
    mocks.getWorkspaceSecret.mockResolvedValue({
      accessToken: null,
      secret: "sk-live-123",
      status: "active",
    });
    const out = await agentMcpResolveHandler({}, CTX);
    expect(out.servers).toHaveLength(1);
    const s = out.servers[0]!;
    expect(s.authKind).toBe("secret");
    expect(s.authStrategy).toBe("bearer");
    expect(s.token).toBe("sk-live-123");
    expect(s.needsReauth).toBe(false);
  });

  it("resolves an oauth server's access token", async () => {
    mocks.rows.mockReturnValueOnce([row({ authKind: "oauth" })]);
    mocks.getWorkspaceSecret.mockResolvedValue({
      accessToken: "oauth-access-tok",
      secret: null,
      status: "active",
    });
    const out = await agentMcpResolveHandler({}, CTX);
    const s = out.servers[0]!;
    expect(s.authKind).toBe("oauth");
    expect(s.token).toBe("oauth-access-tok");
    expect(s.needsReauth).toBe(false);
  });

  it("flags needsReauth when an oauth credential is missing", async () => {
    mocks.rows.mockReturnValueOnce([row({ authKind: "oauth" })]);
    mocks.getWorkspaceSecret.mockResolvedValue({
      accessToken: null,
      secret: null,
      status: "needs_reauth",
    });
    const out = await agentMcpResolveHandler({}, CTX);
    const s = out.servers[0]!;
    expect(s.token).toBeNull();
    expect(s.needsReauth).toBe(true);
    expect(s.authStrategy).toBe("none");
  });

  it("handles an auth=none server (no credential lookup)", async () => {
    mocks.rows.mockReturnValueOnce([
      row({ authStrategy: "none", authKind: "none" }),
    ]);
    const out = await agentMcpResolveHandler({}, CTX);
    const s = out.servers[0]!;
    expect(s.authStrategy).toBe("none");
    expect(s.token).toBeNull();
    expect(s.needsReauth).toBe(false);
    expect(mocks.getWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("never leaks the workspace refresh token into the response", async () => {
    mocks.rows.mockReturnValueOnce([row({ authKind: "oauth" })]);
    mocks.getWorkspaceSecret.mockResolvedValue({
      accessToken: "acc",
      refreshToken: "REFRESH-SECRET",
      secret: null,
      status: "active",
    });
    const out = await agentMcpResolveHandler({}, CTX);
    expect(JSON.stringify(out)).not.toContain("REFRESH-SECRET");
  });
});
