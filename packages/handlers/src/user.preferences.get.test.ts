import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  prefsFindFirst: vi.fn(),
}));

const DB_ROW = {
  theme: "dark",
  language: "fr",
  timezone: "Europe/Paris",
  notificationSettings: { email: true },
};

mocks.prefsFindFirst.mockResolvedValue(DB_ROW);

vi.mock("@oxagen/database", () => ({
  schema: {
    userPreferences: { userId: "userPreferences.userId" },
  },
  withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: {
        userPreferences: { findFirst: mocks.prefsFindFirst },
      },
    }),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { eq: orig.eq };
});

import { userPreferencesGetHandler } from "./user.preferences.get";

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

describe("userPreferencesGetHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prefsFindFirst.mockResolvedValue(DB_ROW);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(userPreferencesGetHandler({}, anonCtx)).rejects.toThrow(
      "user.preferences.get requires an authenticated user",
    );
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns row values from DB", async () => {
    const result = await userPreferencesGetHandler({}, CTX);
    expect(result.theme).toBe("dark");
    expect(result.language).toBe("fr");
    expect(result.timezone).toBe("Europe/Paris");
    expect(result.notification_settings).toEqual({ email: true });
  });

  // ── no-row defaults ───────────────────────────────────────────────────────

  it("returns schema defaults when no preferences row exists", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce(undefined);
    const result = await userPreferencesGetHandler({}, CTX);
    expect(result.theme).toBe("system");
    expect(result.language).toBe("en");
    expect(result.timezone).toBe("UTC");
    expect(result.notification_settings).toEqual({});
  });

  // ── reads from system db ──────────────────────────────────────────────────

  it("invokes the query builder once", async () => {
    await userPreferencesGetHandler({}, CTX);
    expect(mocks.prefsFindFirst).toHaveBeenCalledTimes(1);
  });
});
