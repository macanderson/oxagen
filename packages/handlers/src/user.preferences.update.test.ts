import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  insertOnConflict: vi.fn(),
  prefsFindFirst: vi.fn(),
}));

mocks.insertOnConflict.mockResolvedValue([]);
mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.insertOnConflict });

const UPDATED_ROW = {
  theme: "dark",
  language: "de",
  timezone: "Europe/Berlin",
  notificationSettings: { email: false },
};

mocks.prefsFindFirst.mockResolvedValue(UPDATED_ROW);

vi.mock("@oxagen/database", () => ({
  schema: {
    userPreferences: { userId: "userPreferences.userId" },
  },
  withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({ values: mocks.insertValues }),
      query: {
        userPreferences: { findFirst: mocks.prefsFindFirst },
      },
    }),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { eq: orig.eq };
});

import { userPreferencesUpdateHandler } from "./user.preferences.update";

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

describe("userPreferencesUpdateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertOnConflict.mockResolvedValue([]);
    mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.insertOnConflict });
    mocks.prefsFindFirst.mockResolvedValue(UPDATED_ROW);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      userPreferencesUpdateHandler({ theme: "dark" }, anonCtx),
    ).rejects.toThrow("user.preferences.update requires an authenticated user");
  });

  // ── happy path: partial update ────────────────────────────────────────────

  it("calls insert/onConflictDoUpdate and returns updated row", async () => {
    const result = await userPreferencesUpdateHandler(
      { theme: "dark", language: "de", timezone: "Europe/Berlin" },
      CTX,
    );
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertOnConflict).toHaveBeenCalledTimes(1);
    expect(result.theme).toBe("dark");
    expect(result.language).toBe("de");
    expect(result.timezone).toBe("Europe/Berlin");
  });

  it("re-reads the row after upsert to return canonical state", async () => {
    await userPreferencesUpdateHandler({ timezone: "America/New_York" }, CTX);
    expect(mocks.prefsFindFirst).toHaveBeenCalledTimes(1);
  });

  it("returns notification_settings from the re-read row", async () => {
    const result = await userPreferencesUpdateHandler({}, CTX);
    expect(result.notification_settings).toEqual({ email: false });
  });

  it("succeeds with empty input (no-op partial update)", async () => {
    const result = await userPreferencesUpdateHandler({}, CTX);
    expect(result.theme).toBe("dark");
    expect(mocks.insertOnConflict).toHaveBeenCalledTimes(1);
  });

  // ── defensive guard ───────────────────────────────────────────────────────

  it("throws if re-read returns no row after upsert", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce(undefined);
    await expect(
      userPreferencesUpdateHandler({ theme: "light" }, CTX),
    ).rejects.toThrow("upserted row not found on re-read");
  });
});
