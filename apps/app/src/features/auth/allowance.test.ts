// The sign-up allowance tag reads the Free plan's row (signup.md, Data
// sources). A plan that includes governed actions draws the tag; a missing
// row, a zero allowance or a failed read draws nothing, and a failure is
// reported rather than swallowed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFreePlanAllowance, captureError } = vi.hoisted(() => ({
  readFreePlanAllowance: vi.fn<() => Promise<number | null>>(),
  captureError: vi.fn(),
}));

vi.mock("@/server/viewer", () => ({ readFreePlanAllowance }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));

import { signupIncludesAllowance } from "./allowance";

beforeEach(() => {
  readFreePlanAllowance.mockReset();
  captureError.mockReset();
});

describe("signupIncludesAllowance", () => {
  it("is true when the Free plan includes governed actions", async () => {
    readFreePlanAllowance.mockResolvedValue(5000);
    await expect(signupIncludesAllowance()).resolves.toBe(true);
  });

  it.each([
    ["a zero allowance", 0],
    ["no plan row", null],
  ])("is false for %s (negative)", async (_label, included) => {
    readFreePlanAllowance.mockResolvedValue(included);
    await expect(signupIncludesAllowance()).resolves.toBe(false);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports a failed read and draws no tag (negative)", async () => {
    const error = new Error("connection refused");
    readFreePlanAllowance.mockRejectedValue(error);
    await expect(signupIncludesAllowance()).resolves.toBe(false);
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ error, source: "app" }),
    );
  });
});
