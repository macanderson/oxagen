/**
 * Unit tests for the MCP plugin-type contributor — specifically the
 * per-turn serverAllowlist filtering added in the MCP activation feature.
 *
 * The DB layer is mocked. We spy on drizzle-orm's `inArray` to verify the
 * right SQL condition is (or isn't) passed depending on serverAllowlist state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm spy ─────────────────────────────────────────────────────────
// Wrap `inArray` so we can assert it was called with the right publicIds.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, inArray: vi.fn(real.inArray) };
});

// ── @oxagen/database mock ───────────────────────────────────────────────────
const dbMocks = vi.hoisted(() => {
  const schema = {
    mcpServers: {
      orgId: "mcp.orgId",
      workspaceId: "mcp.workspaceId",
      enabled: "mcp.enabled",
      healthStatus: "mcp.healthStatus",
      orgListingId: "mcp.orgListingId",
      id: "mcp.id",
      publicId: "mcp.publicId",
      name: "mcp.name",
      endpointUrl: "mcp.endpointUrl",
      authStrategy: "mcp.authStrategy",
      authConfig: "mcp.authConfig",
    },
    pluginOrgListings: {
      id: "listing.id",
      enabled: "listing.enabled",
      deletedAt: "listing.deletedAt",
      authKind: "listing.authKind",
    },
    pluginOrgDenylist: {
      orgId: "deny.orgId",
      serverName: "deny.serverName",
    },
  };
  const rowsByTable = new Map<unknown, unknown[]>();
  const builder = {
    select: () => ({
      from: (t: unknown) => {
        const result = rowsByTable.get(t) ?? [];
        const chain = { innerJoin: () => chain, where: async () => result };
        return chain;
      },
    }),
  };
  return { schema, rowsByTable, db: vi.fn((): unknown => builder) };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: dbMocks.db,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMocks.db()),
    schema: dbMocks.schema,
  };
});

// ── Peer deps ───────────────────────────────────────────────────────────────
vi.mock("@oxagen/plugins", () => ({
  getWorkspaceSecret: vi.fn(async () => null),
  DbOAuthClientProvider: vi.fn(),
  markCredentialNeedsReauth: vi.fn(async () => undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(msg?: string) { super(msg ?? "Unauthorized"); this.name = "UnauthorizedError"; }
  },
}));

vi.mock("../../dispatch/mcp-client", () => ({
  connectMcp: vi.fn(async () => ({})),
  materializeMcpTools: vi.fn(async () => ({})),
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import { inArray } from "drizzle-orm";
import { contributeMcpTools } from "./mcp";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

const SERVER_A = {
  id: "srv_a",
  publicId: "mcs_a",
  name: "Server A",
  orgId: "ten_1",
  workspaceId: "ws_1",
  endpointUrl: "https://a.mcp.example.com",
  authStrategy: "none",
  authConfig: {},
  orgListingId: "lst_a",
  healthStatus: "healthy",
  authKind: "none",
};

const SERVER_B = {
  id: "srv_b",
  publicId: "mcs_b",
  name: "Server B",
  orgId: "ten_1",
  workspaceId: "ws_1",
  endpointUrl: "https://b.mcp.example.com",
  authStrategy: "none",
  authConfig: {},
  orgListingId: "lst_b",
  healthStatus: "healthy",
  authKind: "none",
};

describe("contributeMcpTools — serverAllowlist filtering", () => {
  beforeEach(() => {
    dbMocks.rowsByTable.clear();
    vi.mocked(inArray).mockClear();
  });

  it("does NOT call inArray when serverAllowlist is undefined", async () => {
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [SERVER_A, SERVER_B]);
    await contributeMcpTools(CTX, undefined);
    expect(inArray).not.toHaveBeenCalled();
  });

  it("does NOT call inArray when serverAllowlist is an empty Set", async () => {
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [SERVER_A, SERVER_B]);
    await contributeMcpTools(CTX, { serverAllowlist: new Set() });
    expect(inArray).not.toHaveBeenCalled();
  });

  it("calls inArray with the right column and publicIds when serverAllowlist is non-empty", async () => {
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [SERVER_A]);
    await contributeMcpTools(CTX, { serverAllowlist: new Set(["mcs_a"]) });
    expect(inArray).toHaveBeenCalledTimes(1);
    const [col, vals] = (vi.mocked(inArray).mock.calls[0] ?? []) as [unknown, string[]];
    // Column sentinel matches the mock schema publicId value.
    expect(col).toBe(dbMocks.schema.mcpServers.publicId);
    expect(vals).toEqual(["mcs_a"]);
  });

  it("passes all publicIds in the Set to inArray", async () => {
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, []);
    await contributeMcpTools(CTX, { serverAllowlist: new Set(["mcs_a", "mcs_b"]) });
    expect(inArray).toHaveBeenCalledTimes(1);
    const [, vals] = (vi.mocked(inArray).mock.calls[0] ?? []) as [unknown, string[]];
    expect(vals.sort()).toEqual(["mcs_a", "mcs_b"].sort());
  });

  it("returns empty array when no workspace is set in context", async () => {
    // CapabilityContext.workspaceId is string, but contributeMcpTools guards
    // against runtime absence via `if (!ctx.workspaceId)`. Cast to test that path.
    const result = await contributeMcpTools({ ...CTX, workspaceId: "" }, {});
    expect(result).toEqual([]);
    // DB should never be queried when workspaceId is falsy.
    expect(inArray).not.toHaveBeenCalled();
  });
});
