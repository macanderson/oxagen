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
  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
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
  getOrgRole: vi.fn().mockResolvedValue("owner"),
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
    workbench: {
      tools: {
        capabilities: ({
          orgSlug,
          workspaceSlug,
        }: {
          orgSlug: string;
          workspaceSlug: string;
        }) => `/${orgSlug}/${workspaceSlug}/workbench/tools/capabilities`,
      },
    },
  },
}));

import { installBulkPlugin } from "./install-actions";

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
  items: Array<{
    pluginId: string | null;
    orgListingId: string | null;
    error: string | null;
  }>,
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
    const res = await installBulkPlugin({
      orgSlug: "",
      workspaceSlug: "main",
      items: ITEMS,
    });
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
    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: ITEMS,
    });
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

    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: ITEMS,
    });

    expect(res.ok).toBe(true);
    expect(res.failures).toBeUndefined();
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/workbench/tools/capabilities",
    );
  });

  it("wraps the invoke call in runInTenantScope with the correct org and workspace ids", async () => {
    // Guard: installBulkPlugin must call runInTenantScope({ orgId, workspaceId }, fn)
    // so that the invoke() runs inside the right tenant scope. A future accidental
    // removal of the runInTenantScope wrapper would break tenant isolation and
    // this assertion catches it immediately.
    mockInvoke.mockResolvedValue(
      bulkResult([
        { pluginId: "cap-a", orgListingId: "listing-a", error: null },
        { pluginId: "mcp-b", orgListingId: "listing-b", error: null },
      ]),
    );

    await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: ITEMS,
    });

    // ORG.id === "org-1", WS.id === "ws-1" (set up in beforeEach via mocks).
    expect(mockRunInTenantScope).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      expect.any(Function),
    );
  });

  it("calls invoke with plugin.org.install_bulk and normalises 'capability' → agent_capability", async () => {
    mockInvoke.mockResolvedValue(
      bulkResult([
        { pluginId: "cap-a", orgListingId: "listing-a", error: null },
      ]),
    );

    await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: [{ pluginType: "capability", pluginId: "cap-a" }],
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "install_plugins_bulk",
      { items: [{ pluginType: "agent_capability", pluginId: "cap-a" }] },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  // ── per-type marketplace-row mapping (the bug being fixed) ────────────────
  // The marketplace sends each selected row as { catalogServerId, pluginType }
  // only — no pluginId, no custom. installOne then threw "pluginId is required
  // when pluginType is 'agent_capability'" (and "custom is required" for servers)
  // on every item, so bulk install always failed. The action must map each row:
  // capability → pluginId; mcp_server/integration/knowledge_source → custom (name
  // = row id, empty endpoint → registry-resolved); agent_skill → skill install.

  it("maps an agent_capability marketplace row (catalogServerId) → { pluginId }", async () => {
    mockInvoke.mockResolvedValue(
      bulkResult([
        { pluginId: "oxagen/media-image", orgListingId: "l1", error: null },
      ]),
    );

    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: [
        {
          pluginType: "agent_capability",
          catalogServerId: "oxagen/media-image",
        },
      ],
    });

    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "install_plugins_bulk",
      {
        items: [
          { pluginType: "agent_capability", pluginId: "oxagen/media-image" },
        ],
      },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  it("maps an mcp_server marketplace row (catalogServerId) → { custom: { name, empty endpoint } }", async () => {
    mockInvoke.mockResolvedValue(
      bulkResult([{ pluginId: null, orgListingId: "l2", error: null }]),
    );

    await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: [
        { pluginType: "mcp_server", catalogServerId: "@scope/brave-search" },
      ],
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "install_plugins_bulk",
      {
        items: [
          {
            pluginType: "mcp_server",
            custom: {
              name: "@scope/brave-search",
              endpointUrl: "",
              transport: "streamable-http",
              authKind: "none",
            },
          },
        ],
      },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  it("routes agent_skill rows to skill.workspace.install, not plugin.org.install_bulk", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: [{ pluginType: "agent_skill", catalogServerId: "summarize" }],
    });

    expect(res.ok).toBe(true);
    // install_skill (skill.workspace.install) is exposed on ["api","mcp"] only,
    // so the app must NOT assert { surface: "agent" } (that throws surface_denied
    // in prod). The call passes exactly three args — no opts object.
    expect(mockInvoke).toHaveBeenCalledWith(
      "install_skill",
      { slug: "summarize", workspace_id: "ws-1" },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
    );
    // install_bulk is never called when there are no non-skill items.
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "install_plugins_bulk",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("surfaces a skill install failure in the failures list", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("skill not found"));

    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: [{ pluginType: "agent_skill", catalogServerId: "broken-skill" }],
    });

    expect(res.ok).toBe(false);
    expect(res.failures).toEqual(["skill not found"]);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
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
        {
          pluginId: "mcp-b",
          orgListingId: null,
          error: "plugin not found in catalog",
        },
      ]),
    );

    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: ITEMS,
    });

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

    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: ITEMS,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2 of 2/);
    expect(res.failures).toEqual(["DB timeout", "auth denied"]);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  // ── invoke-level throw ────────────────────────────────────────────────────

  it("returns ok:false when invoke itself throws (e.g. IAM denial)", async () => {
    mockInvoke.mockRejectedValue(new Error("CapabilityError: authz_denied"));

    const res = await installBulkPlugin({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: ITEMS,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/authz_denied|Bulk install failed/i);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
