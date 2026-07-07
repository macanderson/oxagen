/**
 * github-mcp-actions.test.ts
 *
 * Unit tests for the installGithubMcp and getGithubMcpInstallStatus
 * server actions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted fixtures ──────────────────────────────────────────────────────────
// vi.hoisted ensures these are available before vi.mock factory resolution.

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockRunInTenantScope: vi.fn(),
  mockWithTenantDb: vi.fn(),
  mockLoggerError: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mockWithTenantDb };
});

// @oxagen/plugins is real — GITHUB_MCP_SERVER is the actual constant.
import { GITHUB_MCP_SERVER } from "@oxagen/plugins";
import { installGithubMcp, getGithubMcpInstallStatus } from "./github-mcp-actions";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SESSION = { user: { id: "user-uuid-1" } };
const ORG = { id: "org-uuid-1" };
const WS = { id: "ws-uuid-1" };

// ── installGithubMcp ──────────────────────────────────────────────────────────

describe("installGithubMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("returns ok:false for empty orgSlug (zod validation)", async () => {
    const res = await installGithubMcp({ orgSlug: "", workspaceSlug: "main" });
    expect(res.ok).toBe(false);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("returns ok:false for empty workspaceSlug (zod validation)", async () => {
    const res = await installGithubMcp({ orgSlug: "acme", workspaceSlug: "" });
    expect(res.ok).toBe(false);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("returns ok:false with auth message for viewer role", async () => {
    // runInTenantScope (role check) → withTenantDb → [{ role: "viewer" }]
    mockRunInTenantScope.mockImplementationOnce(
      (_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ role: "viewer" }]);
        return fn();
      },
    );

    const res = await installGithubMcp({ orgSlug: "acme", workspaceSlug: "main" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owner|admin/i);
  });

  it("returns ok:false with auth message for member role", async () => {
    mockRunInTenantScope.mockImplementationOnce(
      (_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ role: "member" }]);
        return fn();
      },
    );

    const res = await installGithubMcp({ orgSlug: "acme", workspaceSlug: "main" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owner|admin/i);
  });

  it("returns ok:true with orgListingId and authorizeUrl on success (owner role)", async () => {
    const listingId = "listing-uuid-1";

    mockRunInTenantScope
      // 1st: wsRole check
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ role: "owner" }]);
        return fn();
      })
      // 2nd: upsert insert
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ id: listingId }]);
        return fn();
      });

    const res = await installGithubMcp({ orgSlug: "acme", workspaceSlug: "main" });

    expect(res.ok).toBe(true);
    expect(res.orgListingId).toBe(listingId);
    expect(res.authorizeUrl).toContain("/api/v1/mcp/oauth/authorize");
    expect(res.authorizeUrl).toContain("orgSlug=acme");
    expect(res.authorizeUrl).toContain("workspaceSlug=main");
    expect(res.authorizeUrl).toContain(`orgListingId=${listingId}`);
  });

  it("returns ok:true for admin role", async () => {
    const listingId = "listing-uuid-2";

    mockRunInTenantScope
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ role: "admin" }]);
        return fn();
      })
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ id: listingId }]);
        return fn();
      });

    const res = await installGithubMcp({ orgSlug: "acme", workspaceSlug: "main" });
    expect(res.ok).toBe(true);
    expect(res.orgListingId).toBe(listingId);
  });

  it("authorizeUrl contains the raw listing id", async () => {
    const listingId = "listing-abc-123";

    mockRunInTenantScope
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ role: "owner" }]);
        return fn();
      })
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ id: listingId }]);
        return fn();
      });

    const res = await installGithubMcp({ orgSlug: "my-org", workspaceSlug: "dev" });
    expect(res.ok).toBe(true);
    expect(res.authorizeUrl).toContain(listingId);
  });

  it("returns ok:false with error message when DB insert rejects", async () => {
    mockRunInTenantScope
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockResolvedValueOnce([{ role: "owner" }]);
        return fn();
      })
      .mockImplementationOnce((_scope: unknown, fn: () => unknown) => {
        mockWithTenantDb.mockRejectedValueOnce(new Error("DB constraint violation"));
        return fn();
      });

    const res = await installGithubMcp({ orgSlug: "acme", workspaceSlug: "main" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/DB constraint violation|install failed/i);
  });
});

// ── GITHUB_MCP_SERVER constant ────────────────────────────────────────────────

describe("GITHUB_MCP_SERVER descriptor", () => {
  it("has the correct hosted GitHub MCP endpoint URL", () => {
    expect(GITHUB_MCP_SERVER.endpointUrl).toBe("https://api.githubcopilot.com/mcp/");
  });

  it("uses oauth authKind", () => {
    expect(GITHUB_MCP_SERVER.authKind).toBe("oauth");
  });

  it("uses streamable-http transport", () => {
    expect(GITHUB_MCP_SERVER.transport).toBe("streamable-http");
  });

  it('has plugin type "mcp_server"', () => {
    expect(GITHUB_MCP_SERVER.pluginType).toBe("mcp_server");
  });

  it("has the canonical name github-mcp", () => {
    expect(GITHUB_MCP_SERVER.name).toBe("github-mcp");
  });
});

// ── getGithubMcpInstallStatus ─────────────────────────────────────────────────

describe("getGithubMcpInstallStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("returns installed:false for invalid input (empty orgSlug)", async () => {
    const status = await getGithubMcpInstallStatus({ orgSlug: "", workspaceSlug: "main" });
    expect(status.installed).toBe(false);
    expect(status.orgListingId).toBeNull();
    expect(status.connected).toBe(false);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("returns installed:false when no listing exists (empty array)", async () => {
    // First runInTenantScope: listing query returns empty
    mockRunInTenantScope.mockResolvedValueOnce([]);

    const status = await getGithubMcpInstallStatus({ orgSlug: "acme", workspaceSlug: "main" });
    expect(status.installed).toBe(false);
    expect(status.orgListingId).toBeNull();
    expect(status.connected).toBe(false);
  });

  it("returns installed:true, connected:false when listing exists but no mcp_server row", async () => {
    mockRunInTenantScope
      .mockResolvedValueOnce([{ id: "listing-uuid-5" }]) // listing
      .mockResolvedValueOnce([]); // mcp_servers: empty

    const status = await getGithubMcpInstallStatus({ orgSlug: "acme", workspaceSlug: "main" });
    expect(status.installed).toBe(true);
    expect(status.orgListingId).toBe("listing-uuid-5");
    expect(status.connected).toBe(false);
    expect(status.healthStatus).toBeNull();
  });

  it("returns connected:true when mcp_server healthStatus is healthy", async () => {
    mockRunInTenantScope
      .mockResolvedValueOnce([{ id: "listing-uuid-6" }])
      .mockResolvedValueOnce([{ healthStatus: "healthy" }]);

    const status = await getGithubMcpInstallStatus({ orgSlug: "acme", workspaceSlug: "main" });
    expect(status.connected).toBe(true);
    expect(status.healthStatus).toBe("healthy");
  });

  it("returns connected:false when mcp_server healthStatus is degraded", async () => {
    mockRunInTenantScope
      .mockResolvedValueOnce([{ id: "listing-uuid-7" }])
      .mockResolvedValueOnce([{ healthStatus: "degraded" }]);

    const status = await getGithubMcpInstallStatus({ orgSlug: "acme", workspaceSlug: "main" });
    expect(status.connected).toBe(false);
    expect(status.healthStatus).toBe("degraded");
  });

  it("degrades gracefully to not-installed on session error", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("Unauthorized"));
    const status = await getGithubMcpInstallStatus({ orgSlug: "acme", workspaceSlug: "main" });
    expect(status.installed).toBe(false);
    expect(status.connected).toBe(false);
  });

  it("logs and returns not-installed when the listing read rejects (RLS/DB error)", async () => {
    // First runInTenantScope (listing query) rejects → the .catch fallback fires.
    mockRunInTenantScope.mockRejectedValueOnce(new Error("RLS: permission denied"));

    const status = await getGithubMcpInstallStatus({ orgSlug: "acme", workspaceSlug: "main" });

    expect(status).toEqual({
      installed: false,
      orgListingId: null,
      connected: false,
      healthStatus: null,
    });
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [meta, msg] = mockLoggerError.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta).toMatchObject({ orgSlug: "acme", workspaceSlug: "main" });
    expect(meta.err).toBeInstanceOf(Error);
    expect(msg).toMatch(/listing read failed/i);
  });

  it("logs and reports disconnected when the mcp_servers health read rejects", async () => {
    mockRunInTenantScope
      // listing exists
      .mockResolvedValueOnce([{ id: "listing-uuid-8" }])
      // mcp_servers health read rejects → .catch fallback fires
      .mockRejectedValueOnce(new Error("connection reset"));

    const status = await getGithubMcpInstallStatus({ orgSlug: "acme", workspaceSlug: "main" });

    // Listing was found, so installed:true — but health could not be read.
    expect(status.installed).toBe(true);
    expect(status.orgListingId).toBe("listing-uuid-8");
    expect(status.connected).toBe(false);
    expect(status.healthStatus).toBeNull();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [meta, msg] = mockLoggerError.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta).toMatchObject({ orgSlug: "acme", workspaceSlug: "main" });
    expect(msg).toMatch(/mcp_servers health read failed/i);
  });
});
