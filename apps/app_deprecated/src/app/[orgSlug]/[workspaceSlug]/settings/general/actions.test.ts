/**
 * actions.test.ts — unit tests for updateWorkspaceGeneralAction (change
 * workspace name/slug/description through the workspace.settings.write kernel
 * capability).
 *
 * Covers:
 *   - zod validation (rejects bad slug / empty name BEFORE invoke is called)
 *   - IAM gate: non-owner/admin workspace role → ok:false, no invoke
 *   - happy path (unchanged slug): invoke called once with the mapped input +
 *     { surface: "agent" }, returns { ok:true, slug }, revalidatePath fan-out
 *   - changed-slug path: revalidates old + new paths (4 calls)
 *   - handler slug-in-use error → mapped to the stable UX copy
 *   - description "" / omitted → invoke receives description:null
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database (withTenantDb
 * for the role re-read), @oxagen/tenancy, @oxagen/oxagen (invoke),
 * @oxagen/handlers/register (side-effect), next/cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  const dbState: { wsRoleRows: Array<{ role: string }> } = {
    wsRoleRows: [{ role: "owner" }],
  };
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

import { updateWorkspaceGeneralAction } from "./actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "research" };

function base(overrides: Record<string, string> = {}) {
  return {
    orgSlug: "acme",
    workspaceSlug: "research",
    name: "Research",
    slug: "research",
    ...overrides,
  };
}

describe("updateWorkspaceGeneralAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
    // Default invoke result echoes the unchanged slug.
    mockInvoke.mockResolvedValue({
      name: "Research",
      slug: "research",
      description: null,
    });
  });

  it("invokes workspace.settings.write once with { surface:'agent' } and returns ok:true on the happy path (unchanged slug)", async () => {
    mockInvoke.mockResolvedValue({
      name: "Research Renamed",
      slug: "research",
      description: "team space",
    });

    const result = await updateWorkspaceGeneralAction(
      base({ name: "Research Renamed", description: "team space" }),
    );

    expect(result).toEqual({ ok: true, slug: "research" });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_workspace_settings",
      {
        name: "Research Renamed",
        slug: "research",
        description: "team space",
        avatarUrl: null,
      },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
    // Unchanged slug → only the base settings paths are revalidated.
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research/settings/general",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/research/settings");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
  });

  it("revalidates old + new paths when the slug changes", async () => {
    mockInvoke.mockResolvedValue({
      name: "Research",
      slug: "research-2",
      description: null,
    });

    const result = await updateWorkspaceGeneralAction(
      base({ slug: "research-2" }),
    );

    expect(result).toEqual({ ok: true, slug: "research-2" });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research-2/settings/general",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/acme/research-2/settings",
    );
    expect(mockRevalidatePath).toHaveBeenCalledTimes(4);
  });

  it("maps the handler's slug-in-use error to the stable UX copy", async () => {
    mockInvoke.mockRejectedValue(
      new Error(
        'Slug "taken" is already in use by another workspace in this org',
      ),
    );

    const result = await updateWorkspaceGeneralAction(base({ slug: "taken" }));

    expect(result).toEqual({
      ok: false,
      error: "That slug is already taken in this organization.",
    });
  });

  it("rejects an invalid slug before invoking", async () => {
    const result = await updateWorkspaceGeneralAction(
      base({ slug: "Bad Slug!" }),
    );

    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects an empty name before invoking", async () => {
    const result = await updateWorkspaceGeneralAction(base({ name: "" }));

    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects a non owner/admin workspace role without invoking (apps/app IAM gate)", async () => {
    dbState.wsRoleRows = [{ role: "member" }];

    const result = await updateWorkspaceGeneralAction(base());

    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("passes description:null to invoke when the description is omitted", async () => {
    await updateWorkspaceGeneralAction(base());

    expect(mockInvoke).toHaveBeenCalledWith(
      "update_workspace_settings",
      {
        name: "Research",
        slug: "research",
        description: null,
        avatarUrl: null,
      },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("passes description:null to invoke when the description is an empty string", async () => {
    await updateWorkspaceGeneralAction(base({ description: "" }));

    expect(mockInvoke).toHaveBeenCalledWith(
      "update_workspace_settings",
      {
        name: "Research",
        slug: "research",
        description: null,
        avatarUrl: null,
      },
      expect.anything(),
      { surface: "agent" },
    );
  });
});
