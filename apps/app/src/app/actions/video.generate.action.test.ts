/**
 * video.generate.action.test.ts — unit tests for videoGenerateAction.
 *
 * Covers:
 *   (a) Happy path — valid input, org/workspace resolved, invoke returns jobId.
 *   (b) Zod validation — empty prompt, invalid aspectRatio.
 *   (c) Auth failure — getSessionOrRedirect throws.
 *   (d) Org/workspace not found — resolveOrg throws.
 *   (e) Not a member — assertOrgMember throws.
 *   (f) invoke failure — returns ok:false with error.
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/oxagen,
 *            @oxagen/handlers/register.
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

import { videoGenerateAction } from "./video.generate.action";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockSession = { user: { id: "user-abc" } };
const mockOrg = { id: "org-123", slug: "my-org" };
const mockWorkspace = { id: "ws-456", slug: "default" };

const validInput = {
  prompt: "A timelapse of a city at sunset",
  durationSeconds: 10,
  aspectRatio: "16:9" as const,
  style: "cinematic",
  orgSlug: "my-org",
  workspaceSlug: "default",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("videoGenerateAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionOrRedirect.mockResolvedValue(mockSession);
    mockResolveOrg.mockResolvedValue(mockOrg);
    mockResolveWorkspace.mockResolvedValue(mockWorkspace);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue({ jobId: "job-789" });
  });

  // ---------------------------------------------------------------------------
  // (a) Happy path
  // ---------------------------------------------------------------------------

  it("returns ok:true with queued:true and a jobId", async () => {
    const result = await videoGenerateAction(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.queued).toBe(true);
      expect(result.jobId).toBe("job-789");
    }
  });

  it("calls resolveOrg and resolveWorkspace with the correct slugs", async () => {
    await videoGenerateAction(validInput);
    expect(mockResolveOrg).toHaveBeenCalledWith("my-org");
    expect(mockResolveWorkspace).toHaveBeenCalledWith("org-123", "default");
  });

  it("asserts org membership for the authenticated user", async () => {
    await videoGenerateAction(validInput);
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-123", "user-abc");
  });

  it("calls invoke with video.generate and the correct capability payload", async () => {
    await videoGenerateAction(validInput);

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith(
      "generate_video",
      expect.objectContaining({
        prompt: "A timelapse of a city at sunset",
        durationSeconds: 10,
        aspectRatio: "16:9",
        style: "cinematic",
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

  it("works without optional fields (durationSeconds, aspectRatio, style)", async () => {
    const result = await videoGenerateAction({
      prompt: "A cat playing piano",
      orgSlug: "my-org",
      workspaceSlug: "default",
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (b) Zod validation
  // ---------------------------------------------------------------------------

  it("returns ok:false when prompt is an empty string", async () => {
    const result = await videoGenerateAction({ ...validInput, prompt: "" });
    expect(result.ok).toBe(false);
    expect(mockGetSessionOrRedirect).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when aspectRatio is invalid", async () => {
    const result = await videoGenerateAction({
      ...validInput,
      aspectRatio: "4:3" as never,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when durationSeconds exceeds 60", async () => {
    const result = await videoGenerateAction({
      ...validInput,
      durationSeconds: 61,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when durationSeconds is 0 (must be >= 1)", async () => {
    const result = await videoGenerateAction({
      ...validInput,
      durationSeconds: 0,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (c) Auth failure
  // ---------------------------------------------------------------------------

  it("returns ok:false when getSessionOrRedirect throws", async () => {
    mockGetSessionOrRedirect.mockRejectedValue(new Error("redirect"));

    const result = await videoGenerateAction(validInput);

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
    mockResolveOrg.mockRejectedValue(new Error("org not found"));

    const result = await videoGenerateAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/org or workspace not found/i);
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when resolveWorkspace throws", async () => {
    mockResolveWorkspace.mockRejectedValue(new Error("workspace not found"));

    const result = await videoGenerateAction(validInput);

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

    const result = await videoGenerateAction(validInput);

    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (f) invoke failure
  // ---------------------------------------------------------------------------

  it("returns ok:false with error message when invoke throws an Error", async () => {
    mockInvoke.mockRejectedValue(new Error("quota exceeded"));

    const result = await videoGenerateAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("quota exceeded");
    }
  });

  it("returns ok:false with fallback message when invoke throws a non-Error", async () => {
    mockInvoke.mockRejectedValue("string error");

    const result = await videoGenerateAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/could not be queued/i);
    }
  });
});
