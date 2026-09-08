/**
 * #2629's witness. Nothing caught this before: the gateway's credit refusal
 * reached the user verbatim, and it took the Connect-a-source wizard's nightly
 * e2e down three times on the same commit that had passed the night before —
 * only the CI account's balance had changed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  OutputBudgetError,
  OUTPUT_BUDGET_CODE,
  isOutputBudgetError,
  parseOutputBudgetRefusal,
  withOutputBudgetRetry,
} from "./output-budget";

/** The gateway's message, verbatim from the failing nightly run. */
const REFUSAL =
  "This request requires more credits, or fewer max_tokens. You requested up to " +
  "8192 tokens, but can only afford 2048. To increase, visit " +
  "https://openrouter.ai/settings/credits and add more credits";

describe("parseOutputBudgetRefusal", () => {
  it("recognizes the refusal and reads both numbers", () => {
    expect(parseOutputBudgetRefusal(new Error(REFUSAL))).toEqual({
      affordableTokens: 2048,
      requestedTokens: 8192,
    });
  });

  it("reads it out of a wrapped cause, where the SDK often puts the body", () => {
    const wrapped = new Error("Bad Request", { cause: new Error(REFUSAL) });
    expect(parseOutputBudgetRefusal(wrapped)?.affordableTokens).toBe(2048);
  });

  it("reads a plain string error", () => {
    expect(parseOutputBudgetRefusal(REFUSAL)?.affordableTokens).toBe(2048);
  });

  it("tolerates a thousands separator in the number", () => {
    expect(
      parseOutputBudgetRefusal("… but can only afford 12,288.")
        ?.affordableTokens,
    ).toBe(12288);
  });

  it("returns null for anything it does not recognize", () => {
    // The important half: an unparsed error must reach the caller untouched
    // rather than be retried on a guess.
    for (const other of [
      new Error("rate limit exceeded"),
      new Error("context_length_exceeded: 200000 tokens"),
      new Error("upstream connect error"),
      new Error(""),
      undefined,
      null,
      { nope: true },
    ]) {
      expect(parseOutputBudgetRefusal(other), String(other)).toBeNull();
    }
  });

  it("returns null when there is no number to retry with", () => {
    // "more credits" without an affordable ceiling is not actionable.
    expect(
      parseOutputBudgetRefusal(
        new Error("This request requires more credits."),
      ),
    ).toBeNull();
    expect(
      parseOutputBudgetRefusal(new Error("… can only afford 0.")),
    ).toBeNull();
  });
});

describe("withOutputBudgetRetry", () => {
  it("retries once at the ceiling the gateway said it could afford", async () => {
    const attempt = vi
      .fn<(max: number | undefined) => Promise<string>>()
      .mockRejectedValueOnce(new Error(REFUSAL))
      .mockResolvedValueOnce("ok");

    await expect(withOutputBudgetRetry(attempt, 8192)).resolves.toBe("ok");

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, 8192);
    // Exactly the affordable number — not a halving, not unbounded.
    expect(attempt).toHaveBeenNthCalledWith(2, 2048);
  });

  it("never retries more than once", async () => {
    const attempt = vi
      .fn<(max: number | undefined) => Promise<string>>()
      .mockRejectedValue(new Error(REFUSAL));

    await expect(withOutputBudgetRetry(attempt, 8192)).rejects.toBeInstanceOf(
      OutputBudgetError,
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("surfaces a typed error with a stable code and the numbers", async () => {
    const attempt = vi
      .fn<(max: number | undefined) => Promise<string>>()
      .mockRejectedValue(new Error(REFUSAL));

    const err = await withOutputBudgetRetry(attempt, 8192).catch(
      (e: unknown) => e,
    );
    expect(isOutputBudgetError(err)).toBe(true);
    const budget = err as OutputBudgetError;
    expect(budget.code).toBe(OUTPUT_BUDGET_CODE);
    expect(budget.affordableTokens).toBe(2048);
    expect(budget.requestedTokens).toBe(8192);
    expect(budget.cause).toBeDefined();
  });

  it("passes an unrelated error straight through, unretried", async () => {
    const boom = new Error("upstream connect error");
    const attempt = vi
      .fn<(max: number | undefined) => Promise<string>>()
      .mockRejectedValue(boom);

    await expect(withOutputBudgetRetry(attempt, 8192)).rejects.toBe(boom);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not touch the happy path", async () => {
    const attempt = vi
      .fn<(max: number | undefined) => Promise<string>>()
      .mockResolvedValue("ok");

    await expect(withOutputBudgetRetry(attempt, undefined)).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    // An unset ceiling stays unset, so the SDK still sends no max_tokens.
    expect(attempt).toHaveBeenCalledWith(undefined);
  });

  it("can rescue a call that set no ceiling of its own", async () => {
    // The refusal names an affordable number even when we sent none, because
    // the model's own ceiling is what was priced.
    const attempt = vi
      .fn<(max: number | undefined) => Promise<string>>()
      .mockRejectedValueOnce(new Error(REFUSAL))
      .mockResolvedValueOnce("ok");

    await expect(withOutputBudgetRetry(attempt, undefined)).resolves.toBe("ok");
    expect(attempt).toHaveBeenNthCalledWith(1, undefined);
    expect(attempt).toHaveBeenNthCalledWith(2, 2048);
  });
});
