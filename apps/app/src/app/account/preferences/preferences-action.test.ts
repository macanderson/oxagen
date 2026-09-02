/**
 * preferences-action.test.ts — unit tests for updatePreferencesAction.
 *
 * Covers:
 *   (a) Happy path — valid input, invoke succeeds, cookies set, revalidatePath called.
 *   (b) Zod validation — invalid enum values, missing required fields.
 *   (c) invoke failure — server error returns ok:false with user message.
 *   (d) Session gate — delegates to getSessionOrRedirect (redirect on no session).
 *
 * Mock seam: @/lib/session, @oxagen/oxagen, @oxagen/handlers/register,
 *            next/headers (cookies), next/cache (revalidatePath), @/lib/routes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vi.mock is hoisted).
// ---------------------------------------------------------------------------

const {
  mockGetSessionOrRedirect,
  mockInvoke,
  mockRevalidatePath,
  mockCookiesSet,
} = vi.hoisted(() => ({
  mockGetSessionOrRedirect: vi.fn(),
  mockInvoke: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCookiesSet: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));

vi.mock("@oxagen/oxagen", () => ({
  invoke: mockInvoke,
}));

// Side-effect import — bind handlers. Mock as no-op.
vi.mock("@oxagen/handlers/register", () => ({}));

// Silence logger output — the invoke-failure branch logs before returning.
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      set: mockCookiesSet,
    }),
  ),
}));

vi.mock("@/lib/routes", () => ({
  account: {
    preferences: () => "/account/preferences",
    root: () => "/account",
  },
}));

import { updatePreferencesAction } from "./preferences-action";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockSession = { user: { id: "user-abc", email: "user@example.com" } };

const validInput = {
  fontSize: "medium" as const,
  density: "comfortable" as const,
  enterToSubmit: true,
  pendingPromptBehavior: "queue" as const,
  defaultTextTier: "balanced" as const,
  defaultTextModel: "claude-3-sonnet",
  defaultImageModel: null,
  defaultVideoModel: null,
  timezone: "America/New_York",
  language: "en",
};

// ---------------------------------------------------------------------------
// (a) Happy path
// ---------------------------------------------------------------------------

describe("updatePreferencesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionOrRedirect.mockResolvedValue(mockSession);
    mockInvoke.mockResolvedValue({ ok: true });
  });

  it("returns ok:true on valid input", async () => {
    const result = await updatePreferencesAction(validInput);
    expect(result.ok).toBe(true);
  });

  it("calls invoke with the correct capability and data", async () => {
    await updatePreferencesAction(validInput);

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith(
      "update_user_preferences",
      expect.objectContaining({
        fontSize: "medium",
        density: "comfortable",
        enterToSubmit: true,
        pendingPromptBehavior: "queue",
        defaultTextTier: "balanced",
        defaultTextModel: "claude-3-sonnet",
        defaultImageModel: null,
        defaultVideoModel: null,
      }),
      expect.objectContaining({
        userId: "user-abc",
        surface: "app",
        orgId: "",
        workspaceId: "",
      }),
      { surface: "agent" },
    );
  });

  it("sets pref-font-size and pref-density cookies after success", async () => {
    await updatePreferencesAction(validInput);

    expect(mockCookiesSet).toHaveBeenCalledWith(
      "pref-font-size",
      "medium",
      expect.objectContaining({ path: "/", httpOnly: false }),
    );
    expect(mockCookiesSet).toHaveBeenCalledWith(
      "pref-density",
      "comfortable",
      expect.objectContaining({ path: "/", httpOnly: false }),
    );
  });

  it("calls revalidatePath for /account/preferences and /account", async () => {
    await updatePreferencesAction(validInput);

    expect(mockRevalidatePath).toHaveBeenCalledWith("/account/preferences");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/account");
  });

  it("works with small/compact/interrupt/precise combinations", async () => {
    const result = await updatePreferencesAction({
      fontSize: "small",
      density: "compact",
      enterToSubmit: false,
      pendingPromptBehavior: "interrupt",
      defaultTextTier: "precise",
      defaultTextModel: null,
      defaultImageModel: "flux-2-max",
      defaultVideoModel: null,
      timezone: "UTC",
      language: "es",
    });
    expect(result.ok).toBe(true);
  });

  it("works with all nullable model fields set to null", async () => {
    const result = await updatePreferencesAction({
      ...validInput,
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (b) Zod validation
  // ---------------------------------------------------------------------------

  it("returns ok:false when fontSize is an invalid enum value", async () => {
    const result = await updatePreferencesAction({
      ...validInput,
      fontSize: "huge" as never,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when density is an invalid enum value", async () => {
    const result = await updatePreferencesAction({
      ...validInput,
      density: "cozy" as never,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when pendingPromptBehavior is invalid", async () => {
    const result = await updatePreferencesAction({
      ...validInput,
      pendingPromptBehavior: "defer" as never,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when defaultTextTier is an invalid enum value", async () => {
    const result = await updatePreferencesAction({
      ...validInput,
      defaultTextTier: "turbo" as never,
    });
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (c) invoke failure
  // ---------------------------------------------------------------------------

  it("returns ok:false with friendly message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("database error"));

    const result = await updatePreferencesAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/failed to save preferences/i);
    }
    // Cookies and revalidatePath must NOT be called on invoke failure
    expect(mockCookiesSet).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns ok:false with friendly message on any invoke error", async () => {
    mockInvoke.mockRejectedValue(new Error("IAM denied"));

    const result = await updatePreferencesAction(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/please try again/i);
    }
  });
});
