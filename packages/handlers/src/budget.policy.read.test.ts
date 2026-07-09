import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  prefsFindFirst: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { userPreferences: { findFirst: mocks.prefsFindFirst } } }),
  };
});

import { budgetPolicyReadHandler } from "./budget.policy.read";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("budgetPolicyReadHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.prefsFindFirst.mockReset();
  });

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(budgetPolicyReadHandler({}, anonCtx)).rejects.toThrow(
      "budget.policy.read requires an authenticated user",
    );
  });

  it("returns the off-by-default policy when no preferences row exists", async () => {
    mocks.prefsFindFirst.mockResolvedValue(undefined);
    const result = await budgetPolicyReadHandler({}, CTX);
    expect(result).toEqual({
      enabled: false,
      limitUsd: null,
      mode: "prompt",
      graceOveragePct: 0.25,
    });
  });

  it("returns the stored policy", async () => {
    mocks.prefsFindFirst.mockResolvedValue({
      perTurnBudgetEnabled: true,
      perTurnBudgetUsd: 3.5,
      perTurnBudgetMode: "grace",
      perTurnBudgetGracePct: 0.5,
    });
    const result = await budgetPolicyReadHandler({}, CTX);
    expect(result).toEqual({
      enabled: true,
      limitUsd: 3.5,
      mode: "grace",
      graceOveragePct: 0.5,
    });
  });

  it("normalizes an unexpected stored mode to 'prompt'", async () => {
    mocks.prefsFindFirst.mockResolvedValue({
      perTurnBudgetEnabled: true,
      perTurnBudgetUsd: 1,
      perTurnBudgetMode: "garbage",
      perTurnBudgetGracePct: 0.25,
    });
    const result = await budgetPolicyReadHandler({}, CTX);
    expect(result.mode).toBe("prompt");
  });
});
