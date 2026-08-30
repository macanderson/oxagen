import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  insertOnConflict: vi.fn(),
  prefsFindFirst: vi.fn(),
}));

mocks.insertOnConflict.mockResolvedValue([]);
mocks.insertValues.mockReturnValue({
  onConflictDoUpdate: mocks.insertOnConflict,
});

const ROW = {
  perTurnBudgetEnabled: true,
  perTurnBudgetUsd: 2.5,
  perTurnBudgetMode: "prompt",
  perTurnBudgetGracePct: 0.25,
};

mocks.prefsFindFirst.mockResolvedValue(ROW);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: (_table: unknown) => ({ values: mocks.insertValues }),
        query: { userPreferences: { findFirst: mocks.prefsFindFirst } },
      }),
  };
});

import { budgetPolicyWriteHandler } from "./budget.policy.write";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("budgetPolicyWriteHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.insertValues.mockClear();
    mocks.insertOnConflict.mockClear();
    mocks.prefsFindFirst.mockClear();
    mocks.insertOnConflict.mockResolvedValue([]);
    mocks.insertValues.mockReturnValue({
      onConflictDoUpdate: mocks.insertOnConflict,
    });
    mocks.prefsFindFirst.mockResolvedValue(ROW);
  });

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      budgetPolicyWriteHandler({ enabled: true }, anonCtx),
    ).rejects.toThrow("budget.policy.write requires an authenticated user");
  });

  it("upserts and returns the merged budget policy", async () => {
    const result = await budgetPolicyWriteHandler(
      { enabled: true, limitUsd: 2.5, mode: "prompt" },
      CTX,
    );
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertOnConflict).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      enabled: true,
      limitUsd: 2.5,
      mode: "prompt",
      graceOveragePct: 0.25,
    });
  });

  it("only writes provided fields to the update set (enabling without a limit)", async () => {
    await budgetPolicyWriteHandler({ enabled: true }, CTX);
    // limitUsd not provided → not part of the update set (left unchanged).
    const onConflictArg = mocks.insertOnConflict.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(onConflictArg.set).toMatchObject({ perTurnBudgetEnabled: true });
    expect(onConflictArg.set).not.toHaveProperty("perTurnBudgetUsd");
  });

  it("clears the limit when limitUsd is explicitly null", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...ROW,
      perTurnBudgetUsd: null,
    });
    const result = await budgetPolicyWriteHandler({ limitUsd: null }, CTX);
    const onConflictArg = mocks.insertOnConflict.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(onConflictArg.set.perTurnBudgetUsd).toBeNull();
    expect(result.limitUsd).toBeNull();
  });

  it("normalizes an unexpected stored mode to 'prompt'", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce({
      ...ROW,
      perTurnBudgetMode: "garbage",
    });
    const result = await budgetPolicyWriteHandler({ mode: "enforce" }, CTX);
    expect(result.mode).toBe("prompt");
  });

  it("throws if re-read returns no row (defensive guard)", async () => {
    mocks.prefsFindFirst.mockResolvedValueOnce(null);
    await expect(
      budgetPolicyWriteHandler({ enabled: false }, CTX),
    ).rejects.toThrow("upserted row not found on re-read");
  });

  it("first-insert defaults budget off with mode prompt and 0.25 grace", async () => {
    await budgetPolicyWriteHandler({ limitUsd: 5 }, CTX);
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        perTurnBudgetEnabled: false,
        perTurnBudgetMode: "prompt",
        perTurnBudgetGracePct: 0.25,
        perTurnBudgetUsd: 5,
      }),
    );
  });
});
