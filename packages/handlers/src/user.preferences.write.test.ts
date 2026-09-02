import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  insertOnConflict: vi.fn(),
  prefsFindFirst: vi.fn(),
}));

// Simulate the chained drizzle insert().values().onConflictDoUpdate() API
mocks.insertOnConflict.mockResolvedValue([]);
mocks.insertValues.mockReturnValue({
  onConflictDoUpdate: mocks.insertOnConflict,
});

const UPDATED_ROW = {
  fontSize: "large" as const,
  density: "compact" as const,
  enterToSubmit: true,
  pendingPromptBehavior: "interrupt" as const,
  defaultTextTier: "precise" as const,
  defaultTextModel: "anthropic/claude-opus-4.8",
  defaultImageModel: null,
  defaultVideoModel: null,
  timezone: "America/New_York",
  language: "en",
};

mocks.prefsFindFirst.mockResolvedValue(UPDATED_ROW);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      insert: (_table: unknown) => ({ values: mocks.insertValues }),
      query: {
        userPreferences: { findFirst: mocks.prefsFindFirst },
      },
    }),
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: (_table: unknown) => ({ values: mocks.insertValues }),
        query: {
          userPreferences: { findFirst: mocks.prefsFindFirst },
        },
      }),
  };
});

import { userPreferencesWriteHandler } from "./user.preferences.write";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("userPreferencesWriteHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.insertValues.mockClear();
    mocks.insertOnConflict.mockClear();
    mocks.prefsFindFirst.mockClear();
    mocks.insertOnConflict.mockResolvedValue([]);
    mocks.insertValues.mockReturnValue({
      onConflictDoUpdate: mocks.insertOnConflict,
    });
    mocks.prefsFindFirst.mockResolvedValue(UPDATED_ROW);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      userPreferencesWriteHandler({ fontSize: "small" }, anonCtx),
    ).rejects.toThrow("user.preferences.write requires an authenticated user");
  });

  // ── happy path: partial update ─────────────────────────────────────────────

  it("calls insert().values().onConflictDoUpdate() and returns updated row", async () => {
    const result = await userPreferencesWriteHandler(
      { fontSize: "large", density: "compact", enterToSubmit: true },
      CTX,
    );
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertOnConflict).toHaveBeenCalledTimes(1);
    expect(result.fontSize).toBe("large");
    expect(result.density).toBe("compact");
    expect(result.enterToSubmit).toBe(true);
  });

  // ── re-read after upsert ───────────────────────────────────────────────────

  it("re-reads the row after upsert to return canonical state", async () => {
    await userPreferencesWriteHandler(
      { pendingPromptBehavior: "interrupt" },
      CTX,
    );
    expect(mocks.prefsFindFirst).toHaveBeenCalledTimes(1);
  });

  // ── null model fields are passed through ──────────────────────────────────

  it("returns null for nullable model fields when row has them cleared", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...UPDATED_ROW,
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    const result = await userPreferencesWriteHandler(
      { defaultTextModel: null, defaultImageModel: null },
      CTX,
    );
    expect(result.defaultTextTier).toBeNull();
    expect(result.defaultTextModel).toBeNull();
    expect(result.defaultImageModel).toBeNull();
    expect(result.defaultVideoModel).toBeNull();
  });

  // ── missing row after upsert ───────────────────────────────────────────────

  it("throws if re-read returns no row (defensive guard)", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce(null);
    await expect(
      userPreferencesWriteHandler({ fontSize: "small" }, CTX),
    ).rejects.toThrow("upserted row not found on re-read");
  });

  // ── empty input is valid (no-op update) ───────────────────────────────────

  it("succeeds with empty input (no fields changed)", async () => {
    const result = await userPreferencesWriteHandler({}, CTX);
    expect(result.fontSize).toBe("large");
    expect(mocks.insertOnConflict).toHaveBeenCalledTimes(1);
  });

  // ── timezone is persisted and returned ────────────────────────────────────

  it("persists timezone and returns it in the output", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...UPDATED_ROW,
      timezone: "Europe/London",
      language: "en",
    });
    const result = await userPreferencesWriteHandler(
      { timezone: "Europe/London" },
      CTX,
    );
    expect(result.timezone).toBe("Europe/London");
  });

  // ── language is persisted and returned ────────────────────────────────────

  it("persists language and returns it in the output", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...UPDATED_ROW,
      timezone: "America/New_York",
      language: "fr",
    });
    const result = await userPreferencesWriteHandler({ language: "fr" }, CTX);
    expect(result.language).toBe("fr");
  });

  // ── timezone + language together ──────────────────────────────────────────

  it("persists timezone and language together", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...UPDATED_ROW,
      timezone: "Asia/Tokyo",
      language: "ja",
    });
    const result = await userPreferencesWriteHandler(
      { timezone: "Asia/Tokyo", language: "ja" },
      CTX,
    );
    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.language).toBe("ja");
  });

  // ── insert defaults: timezone defaults to UTC, language to en ─────────────

  it("uses UTC and en as defaults on first insert when not provided", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...UPDATED_ROW,
      timezone: "UTC",
      language: "en",
    });
    const result = await userPreferencesWriteHandler(
      { fontSize: "small" },
      CTX,
    );
    // Verify upsert was called (insert sets default timezone/language).
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    // The insert values carry the default timezone and language on first insert.
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "UTC", language: "en" }),
    );
    expect(result.timezone).toBe("UTC");
    expect(result.language).toBe("en");
  });
});
