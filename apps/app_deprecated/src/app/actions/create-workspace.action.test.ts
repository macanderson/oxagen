/**
 * create-workspace.action.test.ts — unit tests for createWorkspaceInlineAction.
 *
 * Covers:
 *   (a) Happy path — delegates to createWorkspaceAction with org/workspace context.
 *   (b) Auth failure — getSessionOrRedirect throws → ok:false.
 *   (c) Org not found — resolveOrg throws → ok:false.
 *   (d) Downstream action failure — createWorkspaceAction returns ok:false.
 *
 * Mock seam: @/lib/session, @/lib/resolve-org,
 *            @/app/[orgSlug]/new-workspace/actions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGetSessionOrRedirect, mockResolveOrg, mockCreateWorkspaceAction } =
  vi.hoisted(() => ({
    mockGetSessionOrRedirect: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockCreateWorkspaceAction: vi.fn(),
  }));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
}));

vi.mock("@/app/[orgSlug]/new-workspace/actions", () => ({
  createWorkspaceAction: mockCreateWorkspaceAction,
}));

import { createWorkspaceInlineAction } from "./create-workspace.action";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockSession = { user: { id: "user-abc" } };
const mockOrg = { id: "org-123", slug: "my-org" };

const validInput = {
  orgSlug: "my-org",
  workspaceSlug: "default",
  name: "My Workspace",
  slug: "my-workspace",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWorkspaceInlineAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionOrRedirect.mockResolvedValue(mockSession);
    mockResolveOrg.mockResolvedValue(mockOrg);
    mockCreateWorkspaceAction.mockResolvedValue({
      ok: true,
      workspaceSlug: "my-workspace",
    });
  });

  // ---------------------------------------------------------------------------
  // (a) Happy path
  // ---------------------------------------------------------------------------

  it("returns ok:true with workspaceSlug on success", async () => {
    const result = await createWorkspaceInlineAction(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceSlug).toBe("my-workspace");
    }
  });

  it("calls createWorkspaceAction with correct orgSlug and FormData containing name+slug", async () => {
    await createWorkspaceInlineAction(validInput);

    expect(mockCreateWorkspaceAction).toHaveBeenCalledOnce();
    const [orgSlugArg, fdArg] = mockCreateWorkspaceAction.mock.calls[0] as [
      string,
      FormData,
    ];
    expect(orgSlugArg).toBe("my-org");
    expect(fdArg.get("name")).toBe("My Workspace");
    expect(fdArg.get("slug")).toBe("my-workspace");
  });

  it("calls resolveOrg with the provided orgSlug", async () => {
    await createWorkspaceInlineAction(validInput);
    expect(mockResolveOrg).toHaveBeenCalledWith("my-org");
  });

  // ---------------------------------------------------------------------------
  // (b) Auth failure
  // ---------------------------------------------------------------------------

  it("returns ok:false when getSessionOrRedirect throws", async () => {
    mockGetSessionOrRedirect.mockRejectedValue(new Error("Not authenticated"));

    const result = await createWorkspaceInlineAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not authenticated/i);
    }
  });

  // ---------------------------------------------------------------------------
  // (c) Org not found
  // ---------------------------------------------------------------------------

  it("returns ok:false when resolveOrg throws (org not found)", async () => {
    mockResolveOrg.mockRejectedValue(new Error("Not found"));

    const result = await createWorkspaceInlineAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  // ---------------------------------------------------------------------------
  // (d) Downstream action failure
  // ---------------------------------------------------------------------------

  it("propagates ok:false from createWorkspaceAction", async () => {
    mockCreateWorkspaceAction.mockResolvedValue({
      ok: false,
      error: "Slug is already taken",
    });

    const result = await createWorkspaceInlineAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Slug is already taken");
    }
  });
});
