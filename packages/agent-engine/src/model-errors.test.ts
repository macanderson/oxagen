/**
 * Fatal-error classification.
 *
 * Moved here with `isFatalAuthOrBillingError` when the TypeScript step loop was
 * deleted; the evaluate stages are what ask it now.
 */
import { describe, it, expect } from "vitest";
import { isFatalAuthOrBillingError } from "./model-errors";

describe("isFatalAuthOrBillingError", () => {
  it("matches credit-balance, insufficient-funds, bad-key, and 401/403", () => {
    expect(
      isFatalAuthOrBillingError(
        new Error(
          "A positive credit balance is required for all requests, please add credits.",
        ),
      ),
    ).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("insufficient_funds"))).toBe(
      true,
    );
    expect(
      isFatalAuthOrBillingError(new Error("Invalid API key provided")),
    ).toBe(true);
    expect(isFatalAuthOrBillingError(new Error("401 unauthorized"))).toBe(true);
    expect(
      isFatalAuthOrBillingError(new Error("request failed with status 403")),
    ).toBe(true);
  });

  it("does not flag transient or unrelated errors", () => {
    expect(isFatalAuthOrBillingError(new Error("model is overloaded"))).toBe(
      false,
    );
    expect(
      isFatalAuthOrBillingError(new Error("context_length_exceeded")),
    ).toBe(false);
    expect(isFatalAuthOrBillingError({ statusCode: 500 })).toBe(false);
  });
});
