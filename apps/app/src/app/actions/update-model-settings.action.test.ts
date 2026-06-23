/**
 * update-model-settings.action.test.ts — unit tests for updateModelSettingsAction.
 *
 * Covers:
 *   (a) Happy path — valid input, resolves org+workspace, asserts membership, calls invoke.
 *   (b) Zod validation — invalid enum for defaultTextTier.
 *   (c) Auth failure — getSessionOrRedirect throws.
 *   (d) Org/workspace not found — resolveOrg or resolveWorkspace throws.
 *   (e) Not a member — assertOrgMember throws.
 *   (f) invoke failure — returns ok:false with error message.
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/oxagen,
 *            @oxagen/handlers/register, @oxagen/oxagen/contracts/*.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockGetSessionOrRedirect,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockInvoke,
} = vi.hoisted(() => ({
  mockGetSessionOrRedirect: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));

vi.mock("@oxagen/oxagen", () => ({
  invoke: mockInvoke,
}));

vi.mock("@oxagen/handlers/register", () => ({}));

// Use the real contract module for validation (it's pure zod, no I/O)
// (no mock needed — it's just z.object validation)

import { updateModelSettingsAction } from "./update-model-settings.action";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockSession = { user: { id: "user-abc" } };
const mockOrg = { id: "org-123", slug: "my-org" };
const mockWorkspace = { id: "ws-456", slug: "default" };

const validInput = {
  orgSlug: "my-org",
  workspaceSlug: "default",
  defaultTextTier: "balanced" as const,
  defaultTextModel: "claude-3-sonnet",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateModelSettingsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionOrRedirect.mockResolvedValue(mockSession);
    mockResolveOrg.mockResolvedValue(mockOrg);
    mockResolveWorkspace.mockResolvedValue(mockWorkspace);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue({
      defaultTextTier: "balanced",
      defaultTextModel: "claude-3-sonnet",
      defaultImageModel: null,
      defaultVideoModel: null,
    });
  });

  // ---------------------------------------------------------------------------
  // (a) Happy path
  // ---------------------------------------------------------------------------

  it("returns ok:true on success", async () => {
    const result = await updateModelSettingsAction(validInput);
    expect(result.ok).toBe(true);
  });

  it("calls resolveOrg and resolveWorkspace with correct slugs", async () => {
    await updateModelSettingsAction(validInput);
    expect(mockResolveOrg).toHaveBeenCalledWith("my-org");
    expect(mockResolveWorkspace).toHaveBeenCalledWith("org-123", "default");
  });

  it("asserts org membership for the authenticated user", async () => {
    await updateModelSettingsAction(validInput);
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-123", "user-abc");
  });

  it("calls invoke with workspace.model.settings.write and correct ctx", async () => {
    await updateModelSettingsAction(validInput);

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith(
      "workspace.model.settings.write",
      expect.objectContaining({
        defaultTextTier: "balanced",
        defaultTextModel: "claude-3-sonnet",
      }),
      expect.objectContaining({
        orgId: "org-123",
        workspaceId: "ws-456",
        userId: "user-abc",
        surface: "app",
      }),
      { surface: "agent" },
    );
  });

  it("works with null/undefined model settings (partial update)", async () => {
    const result = await updateModelSettingsAction({
      orgSlug: "my-org",
      workspaceSlug: "default",
      defaultTextTier: null,
      defaultTextModel: null,
    });
    expect(result.ok).toBe(true);
  });

  it("works when only orgSlug and workspaceSlug are provided (no model fields)", async () => {
    const result = await updateModelSettingsAction({
      orgSlug: "my-org",
      workspaceSlug: "default",
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (b) Zod validation
  // ---------------------------------------------------------------------------

  it("returns ok:false when defaultTextTier is an invalid enum value", async () => {
    const result = await updateModelSettingsAction({
      ...validInput,
      defaultTextTier: "turbo" as never,
    });
    expect(result.ok).toBe(false);
    expect(mockGetSessionOrRedirect).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (c) Auth failure
  // ---------------------------------------------------------------------------

  it("returns ok:false when getSessionOrRedirect throws", async () => {
    mockGetSessionOrRedirect.mockRejectedValue(new Error("Not authenticated"));

    const result = await updateModelSettingsAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not authenticated/i);
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (d) Org/workspace not found
  // ---------------------------------------------------------------------------

  it("returns ok:false when resolveOrg throws", async () => {
    mockResolveOrg.mockRejectedValue(new Error("not found"));

    const result = await updateModelSettingsAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/org or workspace not found/i);
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when resolveWorkspace throws", async () => {
    mockResolveWorkspace.mockRejectedValue(new Error("workspace not found"));

    const result = await updateModelSettingsAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/org or workspace not found/i);
    }
  });

  // ---------------------------------------------------------------------------
  // (e) Not a member
  // ---------------------------------------------------------------------------

  it("returns ok:false when assertOrgMember throws (user not a member)", async () => {
    mockAssertOrgMember.mockRejectedValue(new Error("Forbidden"));

    const result = await updateModelSettingsAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/org or workspace not found/i);
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (f) invoke failure
  // ---------------------------------------------------------------------------

  it("returns ok:false with error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("capability denied"));

    const result = await updateModelSettingsAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("capability denied");
    }
  });

  it("returns ok:false with fallback message when invoke throws non-Error", async () => {
    mockInvoke.mockRejectedValue("some string error");

    const result = await updateModelSettingsAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/failed to update settings/i);
    }
  });
});
