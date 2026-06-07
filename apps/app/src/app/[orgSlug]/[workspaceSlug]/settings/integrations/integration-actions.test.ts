/**
 * integration-actions.test.ts — unit tests for workspace integration server actions.
 *
 * Covers:
 *   setWorkspacePluginEnabledAction:
 *     - validation: empty orgSlug → ok:false
 *     - role gate: viewer role → NOT_AUTHORIZED
 *     - happy path: ok:true, invoke called with plugin.workspace.set_enabled
 *     - invoke error → ok:false
 *   setSecretAction:
 *     - validation: secret too short (empty) → ok:false
 *     - role gate: viewer role → NOT_AUTHORIZED
 *     - happy path: ok:true, invoke called with plugin.credential.set_secret
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
vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: {
    workspaceUsers: {
      workspaceId: "wsu_ws",
      userId: "wsu_user",
      role: "wsu_role",
    },
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    settings: {
      integrations: ({ orgSlug, workspaceSlug }: { orgSlug: string; workspaceSlug: string }) =>
        `/${orgSlug}/${workspaceSlug}/settings/integrations`,
    },
  },
}));

import {
  setWorkspacePluginEnabledAction,
  setSecretAction,
} from "./integration-actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "main" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setWorkspacePluginEnabledAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:false when orgSlug is empty", async () => {
    const res = await setWorkspacePluginEnabledAction({
      orgSlug: "",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      enabled: true,
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false with NOT_AUTHORIZED when workspace role is viewer", async () => {
    dbState.wsRoleRows = [{ role: "viewer" }];
    const res = await setWorkspacePluginEnabledAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      enabled: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("admin");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and calls plugin.workspace.set_enabled on success", async () => {
    const res = await setWorkspacePluginEnabledAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      enabled: false,
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.workspace.set_enabled",
      { orgListingId: "ol-1", enabled: false },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  it("revalidates the integrations settings path on success", async () => {
    await setWorkspacePluginEnabledAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      enabled: true,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/settings/integrations",
    );
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("listing not found"));
    const res = await setWorkspacePluginEnabledAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      enabled: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("listing not found");
  });
});

describe("setSecretAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "admin" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:false when secret is empty", async () => {
    const res = await setSecretAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      secret: "",
    });
    expect(res.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false with NOT_AUTHORIZED when workspace role is member", async () => {
    dbState.wsRoleRows = [{ role: "member" }];
    const res = await setSecretAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      secret: "my-secret-token",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("admin");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and calls plugin.credential.set_secret on success", async () => {
    const res = await setSecretAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      secret: "my-api-key-abc",
    });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "plugin.credential.set_secret",
      { orgListingId: "ol-1", authKind: "secret", secret: "my-api-key-abc" },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  it("revalidates the integrations path on success", async () => {
    await setSecretAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "ol-1",
      secret: "tok",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/main/settings/integrations",
    );
  });
});
