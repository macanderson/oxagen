import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  selectRows: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: (values: unknown) => {
            mocks.values(values);
            return { onConflictDoUpdate: mocks.onConflictDoUpdate };
          },
        }),
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => mocks.selectRows() }),
          }),
        }),
      }),
  };
});

import { userPreferencesSetHandler } from "./user.preferences.set";
import { makeCTX } from "./test-utils/fixtures";

const CTX = makeCTX({ userId: "u_1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onConflictDoUpdate.mockResolvedValue([]);
  mocks.selectRows.mockResolvedValue([
    { language: "pt-BR", theme: "dark", timezone: "America/Sao_Paulo" },
  ]);
});

describe("set_preferences", () => {
  it("upserts only the fields sent and answers with the row read back", async () => {
    const out = await userPreferencesSetHandler({ theme: "dark" }, CTX);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1", theme: "dark", language: "en" }),
    );
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: { updatedByUserId: "u_1", theme: "dark" },
      }),
    );
    expect(out).toEqual({
      locale: "pt-BR",
      theme: "dark",
      timezone: "America/Sao_Paulo",
    });
  });

  it("an empty write changes nothing but the audit column (negative)", async () => {
    await userPreferencesSetHandler({}, CTX);
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { updatedByUserId: "u_1" } }),
    );
  });

  it("reads a stored theme outside the three choices as system", async () => {
    mocks.selectRows.mockResolvedValueOnce([
      { language: "en", theme: "sepia", timezone: "UTC" },
    ]);
    const out = await userPreferencesSetHandler({ locale: "en" }, CTX);
    expect(out.theme).toBe("system");
  });

  it("refuses a caller with no user as forbidden (negative)", async () => {
    await expect(
      userPreferencesSetHandler({ theme: "light" }, makeCTX({ userId: null })),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "forbidden");
    expect(mocks.values).not.toHaveBeenCalled();
  });
});
