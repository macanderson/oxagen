/**
 * plugin-actions.installBulk.test.ts
 *
 * Unit tests for the installBulkPlugin server action, focusing on the
 * partial-failure propagation fix: the action must inspect the installed[]
 * array returned by plugin.org.install_bulk and surface per-item failures
 * rather than silently returning { ok: true } when some items failed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    wsRoleRows: Array<{ role: string }>;
  }
  const dbState: DbState = { wsRoleRows: [{ role: "owner" }] };

  const mockLimit = vi.fn(() => Promise.resolve(dbState.wsRoleRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithTenantDb = vi.fn(
    (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn(
    (_scope: unknown, fn: () => unknown) => fn(),
  );

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockResolveWorkspace: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockInvoke: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    settings: {
      plugins: ({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) =>
        `/${orgSlug}/${workspaceSlug}/settings/plugins`,
    },
  },
}));

import { installBulkPlugin } from "./plugin-actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };

const ITEMS = [
  { pluginType: "capability" as const, pluginId: "cap-a" },
  { pluginType: "mcp_server" as const, pluginId: "mcp-b" },
];

// Helper: build a plugin.org.install_bulk response
function bulkResult(
  items: Array<{ pluginId: string | null; orgListingId: string | null; error: string | null }>,
) {
  return { installed: items };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("installBulkPlugin server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  // ── input validation ──────────────────────────────────────────────────────

  it("returns ok:false for empty orgSlug", async () => {
    const res = await installBulkPlugin({ orgSlug: "", workspaceSlug: "main", items: ITEMS });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when workspaceSlug is missing", async () => {
    const res = await installBulkPlugin({ orgSlug: "acme", items: ITEMS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/workspaceSlug/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ── auth gate ─────────────────────────────────────────────────────────────

  it("returns ok:false with NOT_AUTHORIZED for a viewer role", async () => {
    dbState.wsRoleRows = [{ role: "viewer" }];
    const res = await installBulkPlugin({ orgSlug: "acme", workspaceSlug: "main", items: ITEMS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owner|admin/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ── happy path (all installed) ────────────────────────────────────────────

  it("returns ok:true and revalidates the path when all items succeed", async () => {
    mockInvoke.mockResolvedValue(
      bulkResult([
        { pluginId: "cap-a", orgListingId: "listing-a", error: null },
        { pluginId: "mcp-b", orgListingId: "listing-b", error: null },
      ]),
    );

    const res = await installBulkPlugin({ orgSlug: "acme", workspaceSlug: "main", items: ITEMS });

    expect(res.ok).toBe(true);
    expect(res.failures).toBeUndefined();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/settings/plugins");
  });

  it("calls invoke with plugin.org.install_bulk and passes the items array", async () => {
    mockInvoke.mockResolvedValue(
      bulkResult([{ pluginId: "cap-a", orgListingId: "listing-a", error: null }]),
    );

    await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: [{ pluginType: "capability", pluginId: "cap-a" }],
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.org.install_bulk",
      { items: [{ pluginType: "capability", pluginId: "cap-a" }] },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  // ── partial failure propagation (the bug being fixed) ────────────────────
  // Before the fix, installBulkPlugin discarded the installed[] return value
  // entirely and always returned { ok: true }. Callers could not detect that
  // some plugins failed to install. The fix inspects the array and surfaces
  // failures so callers (workspace bootstrap, UI) know the actual outcome.

  it("returns ok:false with failure messages when some items fail", async () => {
    mockInvoke.mockResolvedValue(
      bulkResult([
        { pluginId: "cap-a", orgListingId: "listing-a", error: null },
        { pluginId: "mcp-b", orgListingId: null, error: "plugin not found in catalog" },
      ]),
    );

    const res = await installBulkPlugin({ orgSlug: "acme", workspaceSlug: "main", items: ITEMS });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/1 of 2/);
    expect(res.failures).toEqual(["plugin not found in catalog"]);
    // Path must NOT be revalidated on partial failure.
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns ok:false when all items fail and lists all failure messages", async () => {
    mockInvoke.mockResolvedValue(
      bulkResult([
        { pluginId: "cap-a", orgListingId: null, error: "DB timeout" },
        { pluginId: "mcp-b", orgListingId: null, error: "auth denied" },
      ]),
    );

    const res = await installBulkPlugin({ orgSlug: "acme", workspaceSlug: "main", items: ITEMS });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2 of 2/);
    expect(res.failures).toEqual(["DB timeout", "auth denied"]);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  // ── invoke-level throw ────────────────────────────────────────────────────

  it("returns ok:false when invoke itself throws (e.g. IAM denial)", async () => {
    mockInvoke.mockRejectedValue(new Error("CapabilityError: authz_denied"));

    const res = await installBulkPlugin({ orgSlug: "acme", workspaceSlug: "main", items: ITEMS });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/authz_denied|Bulk install failed/i);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
