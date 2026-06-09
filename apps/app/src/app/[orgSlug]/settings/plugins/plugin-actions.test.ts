/**
 * plugin-actions.test.ts — unit tests for org plugin server actions.
 *
 * Pattern: resolveManagedOrgForPlugins gates every action to owner/admin only
 * (member role → NOT_AUTHORIZED). Each action delegates to invoke().
 *
 * Covers:
 *   installPluginAction — validation, auth gate, happy path
 *   setOrgPluginEnabledAction — auth gate, happy path, error from invoke
 *   uninstallPluginAction — auth gate, happy path
 *   addDenylistAction — auth gate, happy path
 *   removeDenylistAction — auth gate, happy path
 *   addRegistryAction — auth gate, happy path
 *   removeRegistryAction — auth gate, happy path
 *   installBulkPluginAction — validation (empty items), happy path
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    roleRows: Array<{ role: string | null }>;
  }
  const dbState: DbState = { roleRows: [{ role: "owner" }] };

  const mockLimit = vi.fn(() => Promise.resolve(dbState.roleRows));
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
vi.mock("@/lib/resolve-org", () => ({ resolveOrg: mockResolveOrg }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: {
    orgUsers: { orgId: "orgId_col", userId: "userId_col", role: "role_col" },
  },
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  installPluginAction,
  setOrgPluginEnabledAction,
  uninstallPluginAction,
  addDenylistAction,
  removeDenylistAction,
  addRegistryAction,
  removeRegistryAction,
  installBulkPluginAction,
} from "./plugin-actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };

function setRole(role: string | null) {
  dbState.roleRows = role === null ? [] : [{ role }];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveManagedOrgForPlugins gate — member role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("member");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue({ orgListingId: "ol-1" });
  });

  it("installPluginAction returns not-authorized for member", async () => {
    const res = await installPluginAction({
      orgSlug: "acme",
      catalogServerId: "cat-1",
      pluginType: "mcp_server",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("permission");
  });

  it("setOrgPluginEnabledAction returns not-authorized for member", async () => {
    const res = await setOrgPluginEnabledAction({
      orgSlug: "acme",
      orgListingId: "ol-1",
      enabled: true,
    });
    expect(res.ok).toBe(false);
  });

  it("uninstallPluginAction returns not-authorized for member", async () => {
    const res = await uninstallPluginAction({
      orgSlug: "acme",
      orgListingId: "ol-1",
    });
    expect(res.ok).toBe(false);
  });
});

describe("installPluginAction — owner role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("owner");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue({ orgListingId: "ol-new" });
  });

  it("returns ok:true with orgListingId on success", async () => {
    const res = await installPluginAction({
      orgSlug: "acme",
      catalogServerId: "cat-1",
      pluginType: "mcp_server",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.orgListingId).toBe("ol-new");
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.org.install",
      expect.objectContaining({ catalogServerId: "cat-1", pluginType: "mcp_server" }),
      expect.objectContaining({ orgId: "org-1" }),
      { surface: "agent" },
    );
  });

  it("returns ok:false on invalid input (missing orgSlug)", async () => {
    const res = await installPluginAction({ orgSlug: "", pluginType: "mcp_server" });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("catalog error"));
    const res = await installPluginAction({
      orgSlug: "acme",
      catalogServerId: "cat-1",
      pluginType: "mcp_server",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("catalog error");
  });

  it("revalidates the plugins settings page on success", async () => {
    await installPluginAction({ orgSlug: "acme", catalogServerId: "cat-1", pluginType: "mcp_server" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/settings/plugins");
  });
});

describe("setOrgPluginEnabledAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("admin");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:true and calls invoke with set_enabled", async () => {
    const res = await setOrgPluginEnabledAction({
      orgSlug: "acme",
      orgListingId: "ol-1",
      enabled: false,
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.org.set_enabled",
      { orgListingId: "ol-1", enabled: false },
      expect.objectContaining({ orgId: "org-1" }),
      { surface: "agent" },
    );
  });

  it("returns error when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("not installed"));
    const res = await setOrgPluginEnabledAction({
      orgSlug: "acme",
      orgListingId: "ol-1",
      enabled: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not installed");
  });
});

describe("uninstallPluginAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("owner");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:true and calls plugin.org.uninstall", async () => {
    const res = await uninstallPluginAction({
      orgSlug: "acme",
      orgListingId: "ol-1",
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.org.uninstall",
      { orgListingId: "ol-1" },
      expect.objectContaining({ orgId: "org-1" }),
      { surface: "agent" },
    );
  });
});

describe("addDenylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("owner");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:true and calls plugin.denylist.add with serverName", async () => {
    const res = await addDenylistAction({
      orgSlug: "acme",
      serverName: "evil-server",
      pluginType: "mcp_server",
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.denylist.add",
      expect.objectContaining({ serverName: "evil-server", pluginType: "mcp_server" }),
      expect.objectContaining({ orgId: "org-1" }),
      { surface: "agent" },
    );
  });

  it("returns not-authorized for member", async () => {
    setRole("member");
    const res = await addDenylistAction({
      orgSlug: "acme",
      serverName: "some-server",
      pluginType: "mcp_server",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("removeDenylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("admin");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:true and calls plugin.denylist.remove", async () => {
    const res = await removeDenylistAction({
      orgSlug: "acme",
      serverName: "old-server",
      pluginType: "mcp_server",
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.denylist.remove",
      expect.objectContaining({ serverName: "old-server" }),
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("addRegistryAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("owner");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue({ registryId: "reg-1" });
  });

  it("returns ok:true with registryId on success", async () => {
    const res = await addRegistryAction({
      orgSlug: "acme",
      name: "Internal Registry",
      baseUrl: "https://registry.internal.example.com",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.registryId).toBe("reg-1");
  });

  it("returns not-authorized for member", async () => {
    setRole("member");
    const res = await addRegistryAction({
      orgSlug: "acme",
      name: "My Reg",
      baseUrl: "https://reg.example.com",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("removeRegistryAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("admin");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:true and calls plugin.registry.remove", async () => {
    const res = await removeRegistryAction({
      orgSlug: "acme",
      registryId: "reg-1",
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.registry.remove",
      { registryId: "reg-1" },
      expect.any(Object),
      { surface: "agent" },
    );
  });
});

describe("installBulkPluginAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRole("owner");
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockInvoke.mockResolvedValue({
      installed: [
        { catalogServerId: "cat-1", orgListingId: "ol-1", error: null },
      ],
    });
  });

  it("returns invalid input for empty items array", async () => {
    const res = await installBulkPluginAction({ orgSlug: "acme", items: [] });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true with installed array on success", async () => {
    const res = await installBulkPluginAction({
      orgSlug: "acme",
      items: [{ catalogServerId: "cat-1", pluginType: "mcp_server" }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.installed).toHaveLength(1);
      expect(res.installed?.[0]?.orgListingId).toBe("ol-1");
    }
  });

  it("returns not-authorized for member role", async () => {
    setRole("member");
    const res = await installBulkPluginAction({
      orgSlug: "acme",
      items: [{ catalogServerId: "cat-1", pluginType: "mcp_server" as const }],
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
