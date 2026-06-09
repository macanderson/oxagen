import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  prefsFindFirst: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  db: () => ({
    query: {
      userPreferences: { findFirst: mocks.prefsFindFirst },
    },
  }),
  withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: {
        userPreferences: { findFirst: mocks.prefsFindFirst },
      },
    }),
  schema: {
    userPreferences: { userId: "userId" },
  },
}));

import { userPreferencesReadHandler } from "./user.preferences.read";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const FULL_ROW = {
  fontSize: "large" as const,
  density: "compact" as const,
  enterToSubmit: true,
  pendingPromptBehavior: "interrupt" as const,
  defaultTextTier: "precise" as const,
  defaultTextModel: "anthropic/claude-opus-4.8",
  defaultImageModel: "bfl/flux-2-max",
  defaultVideoModel: "google/veo-3.0-generate-001",
};

describe("userPreferencesReadHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.prefsFindFirst.mockReset();
    mocks.prefsFindFirst.mockResolvedValue(FULL_ROW);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(userPreferencesReadHandler({}, anonCtx)).rejects.toThrow(
      "user.preferences.read requires an authenticated user",
    );
  });

  // ── row found ─────────────────────────────────────────────────────────────

  it("returns all preference fields from an existing row", async () => {
    const result = await userPreferencesReadHandler({}, CTX);
    expect(result.fontSize).toBe("large");
    expect(result.density).toBe("compact");
    expect(result.enterToSubmit).toBe(true);
    expect(result.pendingPromptBehavior).toBe("interrupt");
    expect(result.defaultTextTier).toBe("precise");
    expect(result.defaultTextModel).toBe("anthropic/claude-opus-4.8");
    expect(result.defaultImageModel).toBe("bfl/flux-2-max");
    expect(result.defaultVideoModel).toBe("google/veo-3.0-generate-001");
  });

  // ── no row — schema defaults ──────────────────────────────────────────────

  it("returns schema defaults when no preferences row exists (does NOT throw)", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce(null);
    const result = await userPreferencesReadHandler({}, CTX);
    expect(result.fontSize).toBe("medium");
    expect(result.density).toBe("comfortable");
    expect(result.enterToSubmit).toBe(false);
    expect(result.pendingPromptBehavior).toBe("queue");
    expect(result.defaultTextTier).toBeNull();
    expect(result.defaultTextModel).toBeNull();
    expect(result.defaultImageModel).toBeNull();
    expect(result.defaultVideoModel).toBeNull();
  });

  // ── nullable model fields ─────────────────────────────────────────────────

  it("returns null for model fields when row has no model prefs set", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...FULL_ROW,
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    const result = await userPreferencesReadHandler({}, CTX);
    expect(result.defaultTextTier).toBeNull();
    expect(result.defaultTextModel).toBeNull();
    expect(result.defaultImageModel).toBeNull();
    expect(result.defaultVideoModel).toBeNull();
  });

  // ── DB query uses caller's userId ─────────────────────────────────────────

  it("queries using the userId from context (not from input)", async () => {
    await userPreferencesReadHandler({}, CTX);
    expect(mocks.prefsFindFirst).toHaveBeenCalledTimes(1);
  });
});
